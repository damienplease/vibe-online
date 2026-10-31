'use strict';
(() => {
const $ = id => document.getElementById(id);
let authMode = 'login', me = null, socket = null, conversations = [], activeConversation = null;
let peer = null, localStream = null, currentCall = null, pendingInvite = null, muted = false, cameraOff = false;
let presence = new Set(), audioUrls = [];
let liveRoom = null, activeLiveId = null, liveIsHost = false, liveMicOff = false, liveCamOff = false, shortRecorder = null, shortRecordStream = null, shortRecordChunks = [];
let profileData = null, profileTab = 'posts', profileNavigationTarget = null, profileRequestSeq = 0;
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
  $('viewTitle').textContent = ({home:'Good vibes only.',messages:'Your conversations.',music:'Turn it up.',streaming:'VIBE Live.',shorts:'Little moments. Big vibes.',profile:'Your profile.'})[view] || 'VIBE';
  if (view === 'messages') loadConversations().catch(e => toast(e.message));
  if (view === 'shorts') loadShorts().catch(e => toast(e.message));
  if (view === 'streaming') loadLiveStreams().catch(e => toast(e.message));
  if (view === 'profile') { const target = profileNavigationTarget || me.username; profileNavigationTarget = null; loadProfile(target).catch(e => toast(e.message)); }
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { if (b.dataset.view === 'profile') profileNavigationTarget = null; navigate(b.dataset.view); }));
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
  el.innerHTML = (m.senderId === me.id ? '' : '<button type="button" class="dm-person-link" data-profile="' + esc(m.sender || 'user') + '" aria-label="Open @' + esc(m.sender || 'user') + ' profile"><span class="dm-person-avatar">' + esc((m.sender || 'U').slice(0,2).toUpperCase()) + '</span><strong>@' + esc(m.sender || 'user') + '</strong></button>') + '<div class="bubble">' + esc(m.text) + '</div><time>' + (Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})) + '</time>';
  host.appendChild(el); host.scrollTop = host.scrollHeight;
}
$('messagesList').addEventListener('click', e => { const profile=e.target.closest('[data-profile]'); if(profile){openUserProfile(profile.dataset.profile);} });
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

function attachRemoteMedia(stream) {
  const video=$('remoteVideo'); const audio=$('remoteAudio');
  video.srcObject=stream; video.muted=true;
  audio.srcObject=stream; audio.muted=false; audio.volume=1;
  const play=audio.play(); if(play&&typeof play.catch==='function') play.catch(()=>{ $('callStatus').textContent='Call connected. Tap the page or use the audio controls if you cannot hear the other person.'; });
  if(video.play) video.play().catch(()=>{});
}
async function startCall(mode) {
  if (!activeConversation || activeConversation.type !== 'direct') return toast('Voice and video calls work in direct chats only.');
  const other = activeConversation.members.find(m => m.id !== me.id);
  if (!other) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({audio:true,video:mode==='video'});
    currentCall = {conversationId:activeConversation.id,targetUserId:other.id,mode,initiator:true};
    peer = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(track=>peer.addTrack(track,localStream));
    peer.ontrack = e => { attachRemoteMedia(e.streams[0]); };
    peer.onicecandidate = e => { if(e.candidate && currentCall) socket.emit('call:ice',{conversationId:currentCall.conversationId,targetUserId:currentCall.targetUserId,candidate:e.candidate}); };
    peer.onconnectionstatechange = () => { if(peer && ['failed','disconnected'].includes(peer.connectionState)) $('callStatus').textContent='Connection interrupted. A TURN server may be required.'; };
    $('localVideo').srcObject=localStream; $('remoteVideo').srcObject=null; $('remoteAudio').srcObject=null; $('remoteAudio').srcObject=null;
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
    peer.ontrack=e=>{attachRemoteMedia(e.streams[0]);};
    peer.onicecandidate=e=>{if(e.candidate&&currentCall)socket.emit('call:ice',{conversationId:currentCall.conversationId,targetUserId:currentCall.targetUserId,candidate:e.candidate});};
    $('localVideo').srcObject=localStream; $('remoteVideo').srcObject=null; $('remoteAudio').srcObject=null; $('remoteAudio').srcObject=null;
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
  $('localVideo').srcObject=null;$('remoteVideo').srcObject=null;$('remoteAudio').srcObject=null;$('callLayer').classList.add('hidden');$('incomingActions').classList.add('hidden');currentCall=null;pendingInvite=null;muted=false;cameraOff=false;
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

// ---- Creator profiles and Shorts ----
let shortsPlaybackObserver = null;
function setupShortsAutoplay(host){
  if (shortsPlaybackObserver) { shortsPlaybackObserver.disconnect(); shortsPlaybackObserver = null; }
  const videos = [...host.querySelectorAll('.short-post video')];
  videos.forEach(video => { video.muted = true; video.defaultMuted = true; video.loop = true; video.playsInline = true; video.setAttribute('muted',''); video.setAttribute('playsinline',''); video.preload = 'auto'; });
  if (!('IntersectionObserver' in window)) {
    videos.forEach(video => { if (video.getBoundingClientRect().top >= 0 && video.getBoundingClientRect().top < innerHeight) video.play().catch(()=>{}); });
    return;
  }
  shortsPlaybackObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => { const video = entry.target;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.65) {
        videos.forEach(other => { if (other !== video) other.pause(); });
        const playPromise = video.play(); if (playPromise?.catch) playPromise.catch(()=>{});
      } else { video.pause(); }
    });
  }, { root: host.id === 'shortFeed' ? host : null, threshold: [0, 0.25, 0.65, 0.9] });
  videos.forEach(video => shortsPlaybackObserver.observe(video));
}
async function loadShorts(){
  const data=await api('/api/shorts'); renderShorts(data.shorts,$('shortFeed'));
}
function renderShorts(items,host){
  host.innerHTML='';
  if(!items.length){host.innerHTML='<div class="empty-state compact">No Shorts yet. Record or upload the first one.</div>';return;}
  items.forEach(item=>{
    const card=document.createElement('article');card.className='short-post';card.dataset.shortId=item.id;
    card.innerHTML=`<video src="${esc(item.video_url)}" muted playsinline loop autoplay preload="auto"></video><div class="short-playback-controls"><button type="button" data-video-control="play" aria-label="Pause video">Ⅱ</button><button type="button" data-video-control="sound" aria-label="Turn sound on">🔇</button></div><div class="short-overlay"><div class="short-author"><button class="short-avatar" data-profile="${esc(item.username)}">${esc(item.username.slice(0,2).toUpperCase())}</button><button class="short-username" data-profile="${esc(item.username)}">@${esc(item.username)}</button>${item.is_me?'':`<button class="short-follow" data-follow-creator="${esc(item.user_id)}">${item.is_following?'Following':'+ Follow'}</button>`}</div><p class="short-caption">${esc(item.caption||'')}</p></div><div class="short-actions-rail"><button data-action="like" class="${item.liked?'selected':''}">♥<small>${Number(item.likes)||0}</small></button><button data-action="repost" class="${item.reposted?'selected':''}">↻<small>${Number(item.reposts)||0}</small></button><button data-action="favorite" class="${item.favorited?'selected':''}">★<small>Save</small></button><button data-action="comment">●<small>${Number(item.comments)||0}</small></button></div>`;
    host.appendChild(card);
  });
  if(host.id === 'shortFeed') setupShortsAutoplay(host);
}
async function handleShortAction(e){
  const videoControl=e.target.closest('[data-video-control]'); if(videoControl){const card=videoControl.closest('.short-post');const video=card?.querySelector('video');if(!video)return;if(videoControl.dataset.videoControl==='play'){if(video.paused){video.play().catch(()=>{});videoControl.textContent='Ⅱ';videoControl.setAttribute('aria-label','Pause video');}else{video.pause();videoControl.textContent='▶';videoControl.setAttribute('aria-label','Play video');}}else{video.muted=!video.muted;video.defaultMuted=video.muted;videoControl.textContent=video.muted?'🔇':'🔊';videoControl.setAttribute('aria-label',video.muted?'Turn sound on':'Mute video');if(!video.muted)video.play().catch(()=>{});}return;}
  const profile=e.target.closest('[data-profile]'); if(profile){openUserProfile(profile.dataset.profile);return;}
  const follow=e.target.closest('[data-follow-creator]'); if(follow){try{const r=await api(`/api/users/${follow.dataset.followCreator}/follow`,{method:'POST'});follow.textContent=r.following?'Following':'+ Follow';follow.classList.toggle('following',r.following);const card=follow.closest('[data-short-id]');if(card){const item=(await api('/api/shorts')).shorts.find(x=>x.id===card.dataset.shortId);if(item){follow.textContent=item.is_following?'Following':'+ Follow';}}}catch(err){toast(err.message)}return;}
  const btn=e.target.closest('[data-action]'); if(!btn)return; const card=btn.closest('[data-short-id]');if(!card)return;const id=card.dataset.shortId,action=btn.dataset.action;
  try{
    if(action==='comment'){const data=await api(`/api/shorts/${id}/comments`);const comments=data.comments.map(c=>`<div class="comment-line"><strong>@${esc(c.username)}</strong>${esc(c.text)}</div>`).join('')||'<p>No comments yet.</p>';openModal(`<h2>Comments</h2><div>${comments}</div><label>Add a comment<input id="newShortComment" maxlength="500" placeholder="Write something kind…"></label><button id="sendShortComment" class="primary">Post comment</button>`);$('sendShortComment').addEventListener('click',async()=>{try{await api(`/api/shorts/${id}/comments`,{method:'POST',body:JSON.stringify({text:$('newShortComment').value})});closeModal();await loadShorts();}catch(err){toast(err.message)}});return;}
    const result=await api(`/api/shorts/${id}/${action}`,{method:'POST'});btn.classList.toggle('selected',result.active);if(action==='like')btn.innerHTML=`♥ ${Math.max(0,Number(btn.textContent.replace(/\D/g,''))+(result.active?1:-1))}`;else if(action==='repost')btn.textContent=`↻ ${Math.max(0,Number(btn.textContent.replace(/\D/g,''))+(result.active?1:-1))}`;else btn.textContent=result.active?'★ Saved':'★ Save';
  }catch(err){toast(err.message)}
}
$('shortFeed').addEventListener('click',handleShortAction);
$('profilePanel').addEventListener('click',handleShortAction);
async function uploadShort(file,caption){
  if(!file||!file.type.startsWith('video/'))throw new Error('Choose a video file.');
  if(file.size>100*1024*1024)throw new Error('Videos must be smaller than 100 MB.');
  const contentType=file.type.startsWith('video/webm')?'video/webm':file.type.startsWith('video/mp4')?'video/mp4':file.type.startsWith('video/quicktime')?'video/quicktime':file.type;
  const config=await api('/api/shorts/upload-url',{method:'POST',body:JSON.stringify({contentType,size:file.size})});
  const form=new FormData();form.append('file',file);form.append('upload_preset',config.uploadPreset);form.append('folder','vibe/shorts');
  const uploaded=await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/video/upload`,{method:'POST',body:form});
  const asset=await uploaded.json();if(!uploaded.ok||!asset.secure_url||!asset.public_id)throw new Error(asset.error?.message||'Cloudinary upload failed. Check your preset settings.');
  await api('/api/shorts',{method:'POST',body:JSON.stringify({publicId:asset.public_id,videoUrl:asset.secure_url,caption})});await loadShorts();toast('Your Short has been posted.');
}
$('shortUpload').addEventListener('change',async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;const caption=prompt('Add a caption for your Short (optional):')||'';try{await uploadShort(file,caption)}catch(err){toast(err.message)}});
$('recordShort').addEventListener('click',async()=>{
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)return toast('Video recording is not supported in this browser.');
  try{
    shortRecordStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:true});
    const types=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];const mimeType=types.find(t=>MediaRecorder.isTypeSupported(t));
    shortRecorder=new MediaRecorder(shortRecordStream,mimeType?{mimeType}:undefined);shortRecordChunks=[];
    openModal('<h2>Record a Short</h2><p>Record up to 60 seconds. Make sure everyone shown has agreed to be recorded.</p><video id="recordPreview" class="recording-preview" autoplay muted playsinline></video><div class="short-actions"><button id="beginRecording" class="primary">Start recording</button><button id="stopRecording" class="danger" disabled>Stop & preview</button></div><p id="recordStatus" class="fine">Camera ready.</p>');$('recordPreview').srcObject=shortRecordStream;
    $('beginRecording').onclick=()=>{shortRecorder.start();$('beginRecording').disabled=true;$('stopRecording').disabled=false;$('recordStatus').textContent='Recording… it will stop automatically after 60 seconds.';setTimeout(()=>{if(shortRecorder?.state==='recording')shortRecorder.stop()},60000)};
    $('stopRecording').onclick=()=>{if(shortRecorder?.state==='recording')shortRecorder.stop()};
    shortRecorder.ondataavailable=e=>{if(e.data.size)shortRecordChunks.push(e.data)};
    shortRecorder.onstop=async()=>{shortRecordStream?.getTracks().forEach(t=>t.stop());shortRecordStream=null;const type=shortRecorder.mimeType||'video/webm';const blob=new Blob(shortRecordChunks,{type});const file=new File([blob],`vibe-short-${Date.now()}.${type.includes('mp4')?'mp4':'webm'}`,{type});closeModal();const caption=prompt('Add a caption for your Short (optional):')||'';try{await uploadShort(file,caption)}catch(err){toast(err.message)}};
  }catch(err){shortRecordStream?.getTracks().forEach(t=>t.stop());shortRecordStream=null;toast('Camera access was not available. Allow camera and microphone access on the secure website.');}
});
function openUserProfile(username){ profileNavigationTarget=String(username||'').trim(); navigate('profile'); }
async function loadProfile(username){
  const requestId=++profileRequestSeq;
  const requested=String(username||'').trim();
  if(!requested) throw new Error('Could not identify that VIBE user.');
  const data=await api('/api/profile/'+encodeURIComponent(requested));
  if(requestId!==profileRequestSeq)return data;
  if(!data?.profile?.username) throw new Error('That profile could not be loaded.');
  profileData=data;profileTab='posts';renderProfile();
  $('viewTitle').textContent=data.profile.isMe?'Your profile.':'@'+data.profile.username;
  return data;
}
function renderPeople(people,host){host.innerHTML='';if(!people?.length){host.innerHTML='<div class="empty-state compact">No users to show yet.</div>';return;}people.forEach(u=>{const row=document.createElement('div');row.className='track-row';row.innerHTML=`<div class="avatar">${esc(u.username.slice(0,2).toUpperCase())}</div><div class="track-title"><strong>@${esc(u.username)}</strong></div><button class="smallbtn" data-profile="${esc(u.username)}">View profile</button>${u.id===me.id?'':`<button class="smallbtn" data-follow-user="${esc(u.id)}">${u.following?'Following':'Follow'}</button>`}`;host.appendChild(row)});}
function renderProfile(){
  if(!profileData)return;const p=profileData.profile;const host=$('profilePanel');
  const ownTabs=p.isMe?['posts','reposts','liked','favorites']:['posts','reposts'];
  const tabLabels={posts:'Videos',reposts:'Reposts',liked:'Liked videos',favorites:'Favorites'};
  if(!ownTabs.includes(profileTab))profileTab='posts';
  host.innerHTML=`<div class="profile-cover"></div><div class="profile-header"><div class="profile-avatar">${esc(p.username.slice(0,2).toUpperCase())}</div><div><h2>@${esc(p.username)}</h2><p class="profile-bio">${p.isMe?'Your VIBE profile':'Creator on VIBE'}</p></div>${p.isMe?'':`<button class="primary profile-follow" id="toggleFollow">${p.isFollowing?'Following':'＋ Follow'}</button>`}</div><div class="profile-stats"><div><strong>${Number(p.followers)||0}</strong><span>Followers</span></div><div><strong>${Number(p.following)||0}</strong><span>Following</span></div>${p.isMe?`<div><strong>${Number(p.likes)||0}</strong><span>Likes</span></div>`:''}</div><div class="profile-tabs">${ownTabs.map(tab=>`<button data-profile-tab="${tab}" class="${profileTab===tab?'active':''}">${tabLabels[tab]}</button>`).join('')}</div><div id="profileShorts" class="short-grid"></div>`;
  renderShorts((profileData[profileTab]||[]).map(item=>({...item,is_me:p.isMe,is_following:p.isFollowing})),$('profileShorts'));
  host.querySelectorAll('[data-profile-tab]').forEach(b=>b.addEventListener('click',()=>{profileTab=b.dataset.profileTab;renderProfile()}));
  if(!p.isMe)$('toggleFollow').onclick=async()=>{try{const r=await api(`/api/users/${p.id}/follow`,{method:'POST'});p.isFollowing=r.following;p.followers=Math.max(0,Number(p.followers)+(r.following?1:-1));renderProfile()}catch(e){toast(e.message)}};
}

// ---- Live video rooms (LiveKit SFU) ----
let liveKitModule=null;
async function getLiveKit(){if(!liveKitModule)liveKitModule=await import('https://cdn.jsdelivr.net/npm/livekit-client@2.9.6/dist/livekit-client.esm.mjs');return liveKitModule;}
async function loadLiveStreams(){const data=await api('/api/live');const host=$('liveGrid');host.innerHTML='';if(!data.enabled){host.innerHTML='<div class="tile"><h3>Livestreaming setup required</h3><p>Connect LiveKit credentials to enable live video. The setup steps are in the updated project README.</p></div>';return;}if(!data.streams.length){host.innerHTML='<div class="empty-state compact">Nobody is live right now. Start the first stream.</div>';return;}data.streams.forEach(s=>{const card=document.createElement('article');card.className='live-card';card.innerHTML=`<span class="live-pill">LIVE</span><h3>${esc(s.title)}</h3><p>Hosted by @${esc(s.username)}</p><button class="primary" data-watch-live="${esc(s.id)}">Watch live →</button>`;host.appendChild(card)});await searchLiveCreators();}
async function searchLiveCreators(){const input=$('liveCreatorSearch');if(!input)return;const term=input.value.trim();const data=await api('/api/live/creators?q='+encodeURIComponent(term));const host=$('liveCreatorResults');host.innerHTML='';if(!data.creators.length){host.innerHTML='<div class="empty-state compact">No past livestream hosts found.</div>';return;}data.creators.forEach(u=>{const card=document.createElement('article');card.className='live-card';card.innerHTML=`<h3>@${esc(u.username)}</h3><p>${Number(u.hosted_count)} livestream${Number(u.hosted_count)===1?'':'s'} hosted</p><button class="smallbtn" data-profile="${esc(u.username)}">View profile</button>`;host.appendChild(card)});}
$('refreshLives').addEventListener('click',()=>loadLiveStreams().catch(e=>toast(e.message)));
$('liveCreatorSearch').addEventListener('input',()=>{clearTimeout(window.liveSearchTimer);window.liveSearchTimer=setTimeout(()=>searchLiveCreators().catch(e=>toast(e.message)),250);});
$('liveCreatorResults').addEventListener('click',e=>{const b=e.target.closest('[data-profile]');if(b)openUserProfile(b.dataset.profile);});
$('startLive').addEventListener('click',()=>{openModal('<h2>Start a livestream</h2><p>Choose a clear title. Your camera and microphone will be shared with viewers while you are live.</p><label>Stream title<input id="liveTitleInput" maxlength="100" placeholder="Chilling with the VIBE community"></label><button id="confirmStartLive" class="primary">Go live</button>');$('confirmStartLive').onclick=async()=>{try{const data=await api('/api/live/start',{method:'POST',body:JSON.stringify({title:$('liveTitleInput').value})});closeModal();await joinLive(data.stream.id,true)}catch(e){toast(e.message)}}});
$('liveGrid').addEventListener('click',e=>{const b=e.target.closest('[data-watch-live]');if(b)joinLive(b.dataset.watchLive,false).catch(err=>toast(err.message))});
async function joinLive(id,isHost){
  if(liveRoom)await leaveLive(false);const data=await api(`/api/live/${id}/token`,{method:'POST',body:'{}'});const LK=await getLiveKit();const room=new LK.Room({adaptiveStream:true,dynacast:true});liveRoom=room;activeLiveId=id;liveIsHost=isHost;$('liveStage').classList.remove('hidden');$('liveTitle').textContent=data.title;$('liveMeta').textContent='Hosted by @'+data.username;$('liveVideo').srcObject=null;$('liveControls').classList.toggle('hidden',!isHost);
  room.on(LK.RoomEvent.TrackSubscribed,(track)=>{if(track.kind==='video'){track.attach($('liveVideo'));}else{const el=track.attach();el.autoplay=true;el.style.display='none';$('liveStage').appendChild(el)}});
  room.on(LK.RoomEvent.Disconnected,()=>{if(liveRoom===room){liveRoom=null;toast('You left the livestream.')}});
  await room.connect(data.url,data.token);
  if(isHost){await room.localParticipant.setCameraEnabled(true);await room.localParticipant.setMicrophoneEnabled(true);const pubs=[...room.localParticipant.videoTrackPublications.values()];if(pubs[0]?.track)pubs[0].track.attach($('liveVideo'));}
  $('liveStage').scrollIntoView({behavior:'smooth',block:'start'});await loadLiveStreams();
}
$('leaveLive').addEventListener('click',()=>leaveLive(true));
$('endLive').addEventListener('click',async()=>{if(!activeLiveId)return;try{await api(`/api/live/${activeLiveId}/end`,{method:'POST',body:'{}'});await leaveLive(true);await loadLiveStreams();toast('Livestream ended.')}catch(e){toast(e.message)}});
$('muteLive').addEventListener('click',async()=>{if(!liveRoom)return;liveMicOff=!liveMicOff;await liveRoom.localParticipant.setMicrophoneEnabled(!liveMicOff);$('muteLive').textContent=liveMicOff?'Unmute microphone':'Mute microphone'});
$('cameraLive').addEventListener('click',async()=>{if(!liveRoom)return;liveCamOff=!liveCamOff;await liveRoom.localParticipant.setCameraEnabled(!liveCamOff);$('cameraLive').textContent=liveCamOff?'Turn camera on':'Turn camera off'});
async function leaveLive(refresh){if(liveRoom){await liveRoom.disconnect();liveRoom=null;}if(liveIsHost&&activeLiveId){try{await api(`/api/live/${activeLiveId}/end`,{method:'POST',body:'{}'})}catch{}}activeLiveId=null;liveIsHost=false;liveMicOff=false;liveCamOff=false;$('liveVideo').srcObject=null;$('liveStage').classList.add('hidden');if(refresh)loadLiveStreams().catch(()=>{});}


checkSession();
})();
