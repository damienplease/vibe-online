'use strict';
(() => {
const $ = id => document.getElementById(id);
let authMode = 'login', me = null, socket = null, conversations = [], activeConversation = null;
let peer = null, localStream = null, currentCall = null, pendingInvite = null, muted = false, cameraOff = false;
let presence = new Set(), audioUrls = [];
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // Add a TURN server for reliable cross-network calls.
async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function toast(text) { const el = $('toast'); el.textContent = text; el.classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add('hidden'), 3200); }
function showNotice(text) { $('notice').textContent = text; $('notice').classList.remove('hidden'); }
function hideNotice() { $('notice').classList.add('hidden'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('[data-auth]').forEach(b => b.classList.toggle('active', b.dataset.auth === mode));
  $('authSubmit').textContent = mode === 'login' ? 'Sign in to VIBE →' : 'Create my account →';
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authError').textContent = '';
}
document.querySelectorAll('[data-auth]').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));
$('authForm').addEventListener('submit', async e => {
  e.preventDefault(); $('authError').textContent = '';
  const btn = $('authSubmit'); btn.disabled = true;
  try {
    const data = await api('/api/' + (authMode === 'login' ? 'login' : 'register'), { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    me = data.user; await enterApp();
  } catch (err) { $('authError').textContent = err.message; }
  finally { btn.disabled = false; }
});
async function enterApp() {
  $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
  $('myName').textContent = me.username; $('myAvatar').textContent = me.username.slice(0,2).toUpperCase();
  connectSocket(); await loadConversations(); navigate('home');
}
async function checkSession() {
  try { const data = await api('/api/me'); if (data.user) { me = data.user; await enterApp(); } }
  catch {}
}
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ withCredentials: true });
  socket.on('connect', () => { hideNotice(); conversations.forEach(c => socket.emit('conversation:join', c.id)); });
  socket.on('connect_error', err => showNotice('Live chat connection failed: ' + (err.message || 'please refresh and sign in again.')));
  socket.on('presence:update', users => { presence = new Set(users.map(u => u.userId)); renderConversations(); });
  socket.on('message:new', msg => {
    if (activeConversation?.id === msg.conversationId) appendMessage(msg);
    loadConversations().catch(() => {});
  });
  socket.on('conversation:updated', () => loadConversations().catch(() => {}));
  socket.on('app:error', msg => toast(msg));
  socket.on('call:invite', invite => receiveInvite(invite));
  socket.on('call:accept', p => { if (!currentCall || p.conversationId !== currentCall.conversationId) return; $('callStatus').textContent = 'They accepted. Connecting…'; });
  socket.on('call:decline', () => { toast('Call declined'); finishCall(false); });
  socket.on('call:offer', async p => {
    if (!currentCall || p.conversationId !== currentCall.conversationId || !peer) return;
    try { await peer.setRemoteDescription(new RTCSessionDescription(p.offer)); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); socket.emit('call:answer', { conversationId: currentCall.conversationId, targetUserId: currentCall.targetUserId, answer }); }
    catch(e) { toast('Call setup failed: ' + e.message); finishCall(true); }
  });
  socket.on('call:answer', async p => { if (!currentCall || !peer || p.conversationId !== currentCall.conversationId) return; try { await peer.setRemoteDescription(new RTCSessionDescription(p.answer)); $('callStatus').textContent = 'Call connected'; } catch(e) { toast('Could not connect call.'); } });
  socket.on('call:ice', async p => { if (!peer || !p.candidate) return; try { await peer.addIceCandidate(new RTCIceCandidate(p.candidate)); } catch {} });
  socket.on('call:end', () => { toast('Call ended by the other person'); finishCall(false); });
}
async function loadConversations() {
  const data = await api('/api/conversations'); conversations = data.conversations;
  if (socket?.connected) conversations.forEach(c => socket.emit('conversation:join', c.id));
  renderConversations();
  if (activeConversation) {
    const updated = conversations.find(c => c.id === activeConversation.id);
    if (updated) { activeConversation = updated; updateChatHeading(); }
    else { activeConversation = null; showEmptyChat(); }
  }
}
function otherName(c) {
  if (c.type === 'group') return c.name;
  return c.members.find(m => m.id !== me.id)?.username || 'Direct message';
}
function renderConversations() {
  const host = $('conversationList'); host.innerHTML = '';
  if (!conversations.length) { host.innerHTML = '<div class="fine" style="padding:14px">No chats yet.<br>Use “New” to find a friend.</div>'; return; }
  conversations.forEach(c => {
    const other = c.members.find(m => m.id !== me.id);
    const online = c.type === 'direct' && other && presence.has(other.id);
    const el = document.createElement('button'); el.className = 'conv-item' + (activeConversation?.id === c.id ? ' active' : '');
    el.innerHTML = '<div class="avatar">' + esc(c.type === 'group' ? 'G' : (other?.username || '?').slice(0,2).toUpperCase()) + '</div><div class="conv-meta"><strong>' + esc(otherName(c)) + (online ? ' · 🟢' : '') + '</strong><small>' + esc(c.lastMessage?.text || (c.type === 'group' ? 'Group chat' : 'Start a conversation')) + '</small></div>';
    el.addEventListener('click', () => openConversation(c.id)); host.appendChild(el);
  });
}
function navigate(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('viewTitle').textContent = ({home:'Good vibes only.',messages:'Your conversations.',music:'Turn it up.',shorts:'Little moments. Big vibes.',library:'Your space.'})[view] || 'VIBE';
  if (view === 'messages') loadConversations().catch(e => toast(e.message));
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.goto)));
$('mobileMenu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('menu-open'));
function showEmptyChat() { $('chatEmpty').classList.remove('hidden'); $('chatActive').classList.add('hidden'); }
function updateChatHeading() {
  if (!activeConversation) return;
  $('chatName').textContent = otherName(activeConversation);
  $('chatSub').textContent = activeConversation.type === 'group' ? activeConversation.members.length + ' members · Group chat' : 'Private conversation · ' + (presence.has(activeConversation.members.find(m=>m.id!==me.id)?.id) ? 'Online' : 'Offline');
}
async function openConversation(id) {
  try {
    activeConversation = conversations.find(c => c.id === id); if (!activeConversation) return;
    $('chatEmpty').classList.add('hidden'); $('chatActive').classList.remove('hidden'); updateChatHeading();
    socket?.emit('conversation:join', id);
    const data = await api('/api/conversations/' + encodeURIComponent(id) + '/messages');
    if (activeConversation?.id !== id) return;
    $('messagesList').innerHTML = ''; data.messages.forEach(appendMessage); $('messagesList').scrollTop = $('messagesList').scrollHeight; renderConversations();
  } catch(e) { toast(e.message); }
}
function appendMessage(m) {
  const host = $('messagesList'); if (host.querySelector('[data-message-id="' + CSS.escape(m.id) + '"]')) return;
  const el = document.createElement('div'); el.className = 'msg' + (m.senderId === me.id ? ' mine' : ''); el.dataset.messageId = m.id;
  const time = new Date(m.createdAt);
  el.innerHTML = (m.senderId === me.id ? '' : '<div class="who">' + esc(m.sender || 'user') + '</div>') + '<div class="bubble">' + esc(m.text) + '</div><time>' + (Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})) + '</time>';
  host.appendChild(el); host.scrollTop = host.scrollHeight;
}
$('messageForm').addEventListener('submit', e => {
  e.preventDefault(); const text = $('messageText').value.trim();
  if (!text || !activeConversation || !socket?.connected) return toast('Connect to live chat before sending.');
  socket.emit('message:send', { conversationId: activeConversation.id, text }); $('messageText').value = '';
});
$('newChat').addEventListener('click', openFindUser); $('emptyNewChat').addEventListener('click', openFindUser); $('findUser').addEventListener('click', searchUsers);
$('userSearch').addEventListener('keydown', e => { if (e.key === 'Enter') searchUsers(); });
function openModal(html) { $('modalContent').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); $('modalContent').innerHTML = ''; }
$('closeModal').addEventListener('click', closeModal);
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
function openFindUser() {
  openModal('<h2>Find your people</h2><p>Search for someone by their exact username. They need a VIBE account first.</p><label>Username<input id="modalUsername" placeholder="username" autocomplete="off"></label><div id="userResults"></div><button id="modalSearch" class="primary">Search users</button>');
  $('modalSearch').addEventListener('click', modalSearchUsers);
  $('modalUsername').addEventListener('keydown', e => { if(e.key === 'Enter') modalSearchUsers(); });
}
async function searchUsers() {
  const q = $('userSearch').value.trim();
  try { const data = await api('/api/users?q=' + encodeURIComponent(q)); renderSearchResults(data.users, $('notice')); if (!q) showNotice('Showing registered VIBE users. Choose a username to start a chat.'); navigate('messages'); }
  catch(e) { toast(e.message); }
}
async function modalSearchUsers() {
  const q = $('modalUsername').value.trim();
  try { const data = await api('/api/users?q=' + encodeURIComponent(q)); const host = $('userResults'); host.innerHTML = '';
    if (!data.users.length) host.innerHTML = '<p>No users found. Ask your friend to register first.</p>';
    data.users.forEach(u => { const b = document.createElement('button'); b.className='conv-item'; b.style.width='100%'; b.innerHTML='<div class="avatar">'+esc(u.username.slice(0,2).toUpperCase())+'</div><div class="conv-meta"><strong>'+esc(u.username)+'</strong><small>'+(u.online?'Online':'Offline')+'</small></div><span>＋</span>'; b.addEventListener('click',()=>startDirect(u.username)); host.appendChild(b); });
  } catch(e) { toast(e.message); }
}
function renderSearchResults(users, host) {
  host.innerHTML = '';
  if (!users.length) { host.textContent = 'No matching users found.'; return; }
  users.forEach(u => { const b = document.createElement('button'); b.className='smallbtn'; b.style.margin='5px'; b.textContent = '@'+u.username+(u.online?' · online':''); b.addEventListener('click',()=>startDirect(u.username)); host.appendChild(b); });
}
async function startDirect(username) {
  try { const data = await api('/api/conversations/direct', { method:'POST', body:JSON.stringify({username}) }); closeModal(); await loadConversations(); navigate('messages'); await openConversation(data.conversation.id); toast('Chat opened with @'+username); }
  catch(e) { toast(e.message); }
}
$('newGroup').addEventListener('click', () => {
  openModal('<h2>Create a group</h2><p>Add at least two other registered users by username, separated by commas.</p><label>Group name<input id="groupName" maxlength="60" placeholder="Weekend crew"></label><label>Member usernames<textarea id="groupMembers" rows="3" placeholder="alex, jay, kai"></textarea></label><button id="createGroup" class="primary">Create group</button>');
  $('createGroup').addEventListener('click', async () => {
    const name = $('groupName').value.trim(); const usernames = $('groupMembers').value.split(',').map(s=>s.trim()).filter(Boolean);
    try { const data = await api('/api/conversations/group', {method:'POST',body:JSON.stringify({name,usernames})}); closeModal(); await loadConversations(); navigate('messages'); await openConversation(data.conversation.id); toast('Group created'); }
    catch(e) { toast(e.message); }
  });
});
$('logout').addEventListener('click', async () => {
  try { await api('/api/logout',{method:'POST'}); } catch {}
  if(socket) socket.disconnect(); await finishCall(false); me=null; conversations=[]; activeConversation=null; $('app').classList.add('hidden'); $('auth').classList.remove('hidden'); $('password').value=''; setAuthMode('login');
});

async function startCall(mode) {
  if (!activeConversation || activeConversation.type !== 'direct') return toast('Voice and video calls work in direct chats only.');
  const other = activeConversation.members.find(m => m.id !== me.id);
  if (!other) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({audio:true,video:mode==='video'});
    currentCall = {conversationId:activeConversation.id,targetUserId:other.id,mode,initiator:true};
    peer = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(track=>peer.addTrack(track,localStream));
    peer.ontrack = e => { $('remoteVideo').srcObject = e.streams[0]; };
    peer.onicecandidate = e => { if(e.candidate && currentCall) socket.emit('call:ice',{conversationId:currentCall.conversationId,targetUserId:currentCall.targetUserId,candidate:e.candidate}); };
    peer.onconnectionstatechange = () => { if(peer && ['failed','disconnected'].includes(peer.connectionState)) $('callStatus').textContent='Connection interrupted. A TURN server may be required.'; };
    $('localVideo').srcObject=localStream; $('remoteVideo').srcObject=null;
    $('incomingActions').classList.add('hidden'); $('callTitle').textContent='Calling @'+other.username; $('callStatus').textContent='Waiting for them to answer…'; $('callLayer').classList.remove('hidden');
    socket.emit('call:invite',{conversationId:activeConversation.id,targetUserId:other.id,mode});
    // Offer is sent when callee accepts, after they have acquired their media.
  } catch(e) { await finishCall(false); toast('Could not access microphone/camera. Check browser permissions and HTTPS.'); }
}
async function receiveInvite(invite) {
  if (currentCall) { socket.emit('call:decline',{conversationId:invite.conversationId,targetUserId:invite.fromUserId}); return; }
  pendingInvite = invite;
  $('callTitle').textContent='Incoming '+(invite.mode==='audio'?'voice':'video')+' call';
  $('callStatus').textContent='@'+invite.fromUsername+' is calling you.';
  $('incomingActions').classList.remove('hidden'); $('callLayer').classList.remove('hidden');
}
async function acceptInvite() {
  if(!pendingInvite) return;
  const invite=pendingInvite; pendingInvite=null;
  try {
    localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:invite.mode==='video'});
    currentCall={conversationId:invite.conversationId,targetUserId:invite.fromUserId,mode:invite.mode,initiator:false};
    peer=new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(t=>peer.addTrack(t,localStream));
    peer.ontrack=e=>{$('remoteVideo').srcObject=e.streams[0];};
    peer.onicecandidate=e=>{if(e.candidate&&currentCall)socket.emit('call:ice',{conversationId:currentCall.conversationId,targetUserId:currentCall.targetUserId,candidate:e.candidate});};
    $('localVideo').srcObject=localStream; $('remoteVideo').srcObject=null;
    $('incomingActions').classList.add('hidden'); $('callTitle').textContent='Connected to @'+invite.fromUsername; $('callStatus').textContent='Setting up call…';
    socket.emit('call:accept',{conversationId:invite.conversationId,targetUserId:invite.fromUserId});
    // Callee sends an offer; caller answers.
    const offer=await peer.createOffer(); await peer.setLocalDescription(offer);
    socket.emit('call:offer',{conversationId:invite.conversationId,targetUserId:invite.fromUserId,offer});
  } catch(e) { toast('Could not start call. Use HTTPS and allow microphone/camera.'); finishCall(true); }
}
$('audioCall').addEventListener('click',()=>startCall('audio')); $('videoCall').addEventListener('click',()=>startCall('video'));
$('acceptCall').addEventListener('click',acceptInvite);
$('declineCall').addEventListener('click',()=>{if(pendingInvite&&socket)socket.emit('call:decline',{conversationId:pendingInvite.conversationId,targetUserId:pendingInvite.fromUserId});pendingInvite=null;$('callLayer').classList.add('hidden');$('incomingActions').classList.add('hidden')});
$('endCall').addEventListener('click',()=>finishCall(true));
$('muteCall').addEventListener('click',()=>{muted=!muted;localStream?.getAudioTracks().forEach(t=>t.enabled=!muted);$('muteCall').textContent=muted?'Unmute mic':'Mute mic'});
$('cameraCall').addEventListener('click',()=>{cameraOff=!cameraOff;localStream?.getVideoTracks().forEach(t=>t.enabled=!cameraOff);$('cameraCall').textContent=cameraOff?'Camera on':'Camera off'});
async function finishCall(notify) {
  if(notify&&currentCall&&socket)socket.emit('call:end',{conversationId:currentCall.conversationId,targetUserId:currentCall.targetUserId});
  if(peer){peer.ontrack=null;peer.onicecandidate=null;peer.close();peer=null}
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}
  $('localVideo').srcObject=null;$('remoteVideo').srcObject=null;$('callLayer').classList.add('hidden');$('incomingActions').classList.add('hidden');currentCall=null;pendingInvite=null;muted=false;cameraOff=false;
  $('muteCall').textContent='Mute mic';$('cameraCall').textContent='Camera off';
}
let playlist = [], currentAudioIndex = -1;
$('audioFiles').addEventListener('change',e=>{
  for(const file of e.target.files) { if(!file.type.startsWith('audio/')) continue; playlist.push({name:file.name,file,url:URL.createObjectURL(file)}); }
  renderPlaylist(); e.target.value='';
});
function renderPlaylist() {
  const host=$('trackList'); host.innerHTML='';
  if(!playlist.length){host.innerHTML='<div class="empty-state compact">Choose an audio file to build your local playlist.</div>';return;}
  playlist.forEach((t,i)=>{const row=document.createElement('div');row.className='track-row';row.innerHTML='<div class="track-art">♫</div><div class="track-title"><strong>'+esc(t.name)+'</strong><small>Local file · only on this device</small></div><button data-play-local="'+i+'">▶ Play</button><button data-remove-local="'+i+'">Remove</button>';host.appendChild(row)});
}
$('trackList').addEventListener('click',e=>{
  const play=e.target.closest('[data-play-local]'); const remove=e.target.closest('[data-remove-local]');
  if(play){playLocal(Number(play.dataset.playLocal));}
  if(remove){const i=Number(remove.dataset.removeLocal);if(playlist[i])URL.revokeObjectURL(playlist[i].url);playlist.splice(i,1);if(currentAudioIndex===i){$('audio').pause();$('audio').removeAttribute('src');currentAudioIndex=-1}renderPlaylist()}
});
function playLocal(i) { const t=playlist[i]; if(!t)return;currentAudioIndex=i;$('audio').src=t.url;$('audio').play().catch(()=>toast('Press play on the audio player to start playback.'));$('trackName').textContent=t.name;$('trackMeta').textContent='Local file · not uploaded'; }
$('audio').addEventListener('ended',()=>{if(currentAudioIndex>=0&&currentAudioIndex+1<playlist.length)playLocal(currentAudioIndex+1)});
checkSession();
})();
