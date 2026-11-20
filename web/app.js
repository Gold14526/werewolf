import {STANDARD_CONFIG, ROLE_INFO, validateConfig, createGame, viewGame, act, advance} from './engine.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy = value => structuredClone(value);
const storage = {get(key, fallback=''){try{return localStorage.getItem(`moonwolf:${key}`) ?? fallback;}catch{return fallback;}},set(key,value){try{localStorage.setItem(`moonwolf:${key}`,value);}catch{}}};
const roleKeys = Object.keys(ROLE_INFO);
const size = config => Object.values(config.roles).reduce((a,b)=>a+b,0);
const sessionStore = {get(key){try{return sessionStorage.getItem(`moonwolf:${key}`)||'';}catch{return '';}},set(key,val){try{sessionStorage.setItem(`moonwolf:${key}`,val);}catch{}}};
const state = {
  page:'lobby', name:storage.get('name','玩家'+Math.floor(1000+Math.random()*9000)),
  apiBase:storage.get('apiBase',window.MOONWOLF_CONFIG?.apiBase || '').replace(/\/$/,''),
  token:'', player:null, online:false, checking:true, room:null, rooms:[], history:[], standings:[],
  demo:false, demoGame:null, demoHistory:[], replay:null, target:null, actionKey:'', draft:'', wolfDraft:'',
  config:copy(STANDARD_CONFIG), modal:null, busy:false, pollFailures:0,
  pendingInvite: /^\d{6}$/.test(new URL(location.href).searchParams.get('room')||'') ? new URL(location.href).searchParams.get('room') : null,
};
storage.set('name',state.name);
const badge = role => `<span class="badge ${role==='wolf'?'wolf':role==='villager'?'villager':'god'}">${escape(ROLE_INFO[role]?.name||role)}</span>`;
const roleTags = config => roleKeys.filter(r=>config.roles[r]).map(r=>`<span class="badge ${r==='wolf'?'wolf':r==='villager'?'villager':'god'}">${config.roles[r]} ${escape(ROLE_INFO[r].name)}</span>`).join(' ');
const resultLabel = winner => winner==='wolf'?'狼人胜利':winner==='good'?'好人胜利':'平局';
const formatTime = at => at ? new Date(at).toLocaleString('zh-CN',{hour12:false}) : '—';
let toastTimer, lastRoomJson='', pollLock=false, botTimer=0, historyTick=0;
let connectPromise=null, nextReconnectAt=0, retryDelay=5000, networkRevision=0, inviteShown=false;

function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
function modal(title,body){state.modal=title;$('#modal-root').innerHTML=`<div class="overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${title}</h2><button class="close" data-do="close-modal" aria-label="关闭">×</button></div><div class="modal-body">${body}</div></section></div>`;setTimeout(()=>$('.modal input,.modal button,.modal select')?.focus(),0);}
function closeModal(){state.modal=null;$('#modal-root').innerHTML='';}
function rules(){return `<ol class="rules-list">
  <li><strong>身份：</strong>默认 12 人标准局，${roleTags(STANDARD_CONFIG)}。开局随机分配身份；狼人知道同伴，其他玩家只知道自己。</li>
  <li><strong>天黑：</strong>守卫、狼人、预言家、女巫依次行动。狼人可在队内频道讨论，选择袭击目标；预言家独自获知查验结果。已配置的夜间阶段保留固定时长，不因对应身份出局而跳过。未操作至超时视为放弃。</li>
  <li><strong>女巫与守卫：</strong>女巫一瓶解药、一瓶毒药，每夜最多一瓶，仅首夜能自救；守卫不能连续守同一人。同守同救仍会死亡。</li>
  <li><strong>天亮：</strong>公布死亡玩家，不公开身份。首夜死者可发表遗言；随后存活玩家依次发言，只有当前玩家可以发送，可点击「结束发言」。未轮到时可先写草稿。</li>
  <li><strong>投票：</strong>所有存活玩家同时投票，可弃权，不能投自己。投票结束后公布票型；平票玩家再发言并重新投票，再次平票则无人出局。</li>
  <li><strong>猎人：</strong>被袭击或放逐后可开枪带走一人；被女巫毒杀不能开枪。<strong>狼人自爆：</strong>白天发言或投票时可自爆，立即出局并结束当天。</li>
  <li><strong>胜负：</strong>狼人全部出局则好人获胜。默认屠边：村民全部出局或神职全部出局，狼人获胜；自定义可选屠城，须淘汰所有好人。超过 20 夜判平局。</li>
  <li><strong>复盘：</strong>结束后公开所有身份，可查看发言、夜间行动和队内聊天。私密房间的记录仅参与者可查看。本版为文字游戏，不设警长竞选。</li>
</ol>`;}

function shell(content){return `<div class="container"><header class="header"><a href="#lobby" class="logo" data-page="lobby">狼人杀</a><button class="account" data-do="profile">${escape(state.name)}</button></header>
  <nav class="navbar" aria-label="主导航"><button class="nav-link ${state.page==='lobby'?'active':''}" data-page="lobby">游戏大厅</button><button class="nav-link ${state.page==='room'?'active':''}" data-page="room">我的房间${state.room?' · '+escape(state.room.code):''}</button><button class="nav-link ${state.page==='history'?'active':''}" data-page="history">对局历史</button><button class="nav-link ${state.page==='rules'?'active':''}" data-page="rules">游戏规则</button><button class="nav-link settings" data-do="settings">联机设置</button></nav>
  ${state.checking?'<div class="alert info">正在连接游戏服务…</div>':state.online&&state.pollFailures<3?'<div class="alert info">已连接联机服务。匹配默认 12 人标准局，也可以创建房间邀请朋友加入。</div>':`<div class="alert warning">${state.pollFailures?'连接暂时中断，正在自动恢复；你的座位与草稿会保留。':'暂时无法连接游戏服务，正在自动重试。'} <button class="link-button" data-do="reconnect">立即重连</button> · <button class="link-button" data-do="settings">联机设置</button></div>`}
  <main>${content}</main><footer class="footer">狼人杀 · 文字发言推理 <span>12 人标准局 / 6–18 人自定义 · <button class="link-button" data-page="rules">规则说明</button></span></footer></div>`;}

function historyTable(list,empty='暂无已结束的对局'){return `<div class="table-wrap"><table class="table"><thead><tr><th>对局</th><th>结果</th><th>天数</th><th>结束时间</th></tr></thead><tbody>${list.length?list.map(g=>`<tr><td><button class="link-button history-link" data-history="${escape(g.code)}">#${escape(g.code)}</button>${g.demo?' <small class="muted">试玩</small>':''}</td><td><span class="badge ${g.winner==='wolf'?'wolf':g.winner==='good'?'good':'villager'}">${resultLabel(g.winner)}</span></td><td>${escape(g.round)}</td><td>${formatTime(g.endedAt)}</td></tr>`).join(''):`<tr><td colspan="4" class="empty-row">${empty}</td></tr>`}</tbody></table></div>`;}
function lobby(){
  const me=state.standings.find(x=>x.id===state.player?.id);
  return `<section class="hero"><h1 class="hero-title">狼人杀</h1><p class="hero-description">12 人发言推理 · ${roleTags(STANDARD_CONFIG)} · 天黑秘密行动，天亮轮流发言、投票放逐</p>
    <div class="hero-actions">${state.room?`<button class="btn secondary" data-page="room">回到${state.room.game?'进行中的对局':'我的房间'}</button>`:`<button class="btn secondary" data-do="match">开始匹配</button>`}<button class="btn outline-light" data-do="create">自选配置开房</button><button class="btn outline-light" data-do="join-modal">输入房号加入</button></div>
    <p class="small hero-help">凑满 12 人自动开局。请预留充足时间，匹配时保持本页面打开。自建房由房主在全员准备后开始。</p></section>
  <div class="columns"><div class="main-column"><section class="card stats-bar"><div class="stat"><small>我的对局</small><strong>${me?.games||0}</strong></div><div class="stat"><small>胜场</small><strong>${me?.wins||0}</strong></div><div class="stat"><small>胜率</small><strong>${me?.games?((me.wins/me.games)*100).toFixed(1)+'%':'—'}</strong></div><button class="link-button" data-page="history">查看对局记录</button></section>
    <section class="card"><div class="card-header"><strong>最近对局</strong><button class="link-button" data-page="history">全部历史</button></div>${historyTable([...state.demoHistory,...state.history].slice(0,10))}</section>
    <section class="card"><div class="card-header"><strong>公开房间</strong><button class="link-button" data-do="refresh">刷新</button></div><div class="table-wrap"><table class="table"><thead><tr><th>房号</th><th>房间名</th><th>人数</th><th></th></tr></thead><tbody>${state.rooms.length?state.rooms.map(r=>`<tr><td>${escape(r.code)}</td><td>${escape(r.name)}</td><td>${r.playerCount} / ${r.capacity}</td><td><button class="btn primary small" data-join="${escape(r.code)}">加入</button></td></tr>`).join(''):'<tr><td colspan="4" class="empty-row">暂无等待中的公开房间</td></tr>'}</tbody></table></div></section>
    <section class="card"><div class="card-header"><strong>规则</strong></div><div class="card-body">${rules()}</div></section></div>
  <aside class="side-column"><section class="card"><div class="card-header"><strong>加入好友房间</strong></div><div class="card-body"><form id="quick-join"><label class="field"><span>6 位房号</span><input id="quick-code" class="input room-code-input" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="例如 123456" required autocomplete="off"></label><button class="btn primary full" type="submit">加入房间</button></form><p class="small muted">房号由系统随机生成，向房主获取即可加入。</p></div></section>
    <section class="card"><div class="card-header"><strong>胜场榜</strong></div><div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>玩家</th><th>胜 / 局</th><th>胜率</th></tr></thead><tbody>${state.standings.length?state.standings.slice(0,20).map((p,i)=>`<tr><td>${i+1}</td><td class="player-name">${escape(p.name)}</td><td>${p.wins} / ${p.games}</td><td>${(p.games?p.wins/p.games*100:0).toFixed(1)}%</td></tr>`).join(''):'<tr><td colspan="4" class="empty-row">完成第一局后生成战绩</td></tr>'}</tbody></table></div></section>
    <section class="card"><div class="card-header"><strong>本地试玩</strong></div><div class="card-body"><p class="small muted">与随机行动的电脑玩家走一遍完整流程，熟悉身份技能和操作。试玩不参与联机匹配与排行榜。</p><button class="btn secondary full" data-do="demo">开始本地试玩</button></div></section></aside></div>`;
}

function roomView(){
  const room=state.replay||state.room;if(!room)return `<section class="card"><div class="card-body"><h2>你还没有加入房间</h2><p class="muted">开始匹配、自选配置开房，或使用朋友分享的 6 位房号加入。</p><div class="controls"><button class="btn primary" data-do="match">开始匹配</button><button class="btn secondary" data-do="create">创建房间</button></div></div></section>`;
  const game=room.game, myId=state.player?.id, me=room.players.find(p=>p.id===myId), host=room.hostId===myId;
  const players=game?.players||room.players, capacity=size(room.config);
  const current=game?.players.find(p=>p.id===game.currentSpeakerId);
  const actionKey=game?`${game.round}:${game.phase}:${game.currentSpeakerId||''}:${game.deadline}`:'';
  if(state.actionKey!==actionKey){state.actionKey=actionKey;state.target=null;}
  return `<div class="section-heading"><h1>狼人杀 · ${state.replay?'对局回放':'房间'} #${escape(room.code)}</h1><div><button class="link-button" data-page="lobby">大厅</button> · <button class="link-button" data-page="history">对局历史</button></div></div>
  ${state.demo&&!state.replay?'<div class="alert warning">本地试玩 · 其余座位为随机行动的电脑玩家，房号仅用于本次演示。</div>':''}
  <div class="room-status"><div><strong class="status-title">${game?game.phase==='finished'?resultLabel(game.winner):`第 ${game.round} ${['guard','wolf','seer','witch'].includes(game.phase)?'夜':'天'} · ${escape(game.phaseLabel)}`:room.matchmaking?'匹配中，等待玩家加入':'等待玩家准备'}</strong><p class="status-detail">${game?game.phase==='finished'?'游戏结束，所有身份与记录已公开。':current?`当前由 ${current.seat} 号 ${escape(current.name)} ${game.phase==='lastwords'?'发表遗言':'发言'}。`:'请根据自己的身份提示操作，其他玩家等待。':`${escape(room.name)} · ${room.players.length} / ${capacity} 人 · ${room.visibility==='private'?'私密房间':'公开房间'}`}</p></div>${game?.deadline?`<strong class="timer" data-deadline="${game.deadline}"></strong>`:!game?`<div class="controls"><button class="btn secondary small" data-do="copy-room">复制房号</button><button class="btn primary small" data-do="copy-invite">复制邀请链接</button></div>`:''}</div>
  <div class="game-columns"><div class="game-left"><div class="seats">${Array.from({length:capacity},(_,i)=>{
    const p=players.find(x=>x.seat===i+1);if(!p)return `<div class="seat empty"><span class="seat-number">${i+1}</span><div class="avatar">＋</div><div class="seat-name muted">等待加入</div></div>`;
    const ready=room.players.find(x=>x.id===p.id)?.ready;
    return `<div class="seat ${p.id===myId?'me':''} ${p.alive===false?'dead':''} ${p.id===game?.currentSpeakerId?'speaking':''}"><span class="seat-number">${p.seat}</span><span class="seat-role">${p.role?badge(p.role):''}</span><div class="avatar" style="--avatar-hue:${(p.seat*47)%360}">${escape(p.name.slice(0,1))}</div><div class="seat-name">${escape(p.name)}${p.id===myId?'（你）':''}</div><div class="seat-status">${p.alive===false?'<span class="badge villager">出局</span>':game?p.id===game.currentSpeakerId?'<span class="badge good">正在发言</span>':'存活':ready?'<span class="badge good">已准备</span>':'未准备'}${p.id===room.hostId&&!game?' · 房主':''}</div></div>`;
  }).join('')}</div>
  ${game?game.myRole&&!state.replay?`<div class="identity">你的身份：${badge(game.myRole)} <span class="small">${escape(ROLE_INFO[game.myRole]?.description)}</span></div>${privateInfo(game)}`:'':`<div class="config-tags">${roleTags(room.config)}</div><p class="small muted">${room.config.victory==='side'?'屠边':'屠城'} · 夜间 ${room.config.nightSeconds} 秒 · 每人发言 ${room.config.daySeconds} 秒</p>`}
  ${!game?`<div class="controls">${room.matchmaking?'<span class="queue-count">满员后自动开始</span>':`<button class="btn ${me?.ready?'secondary':'primary'}" data-do="ready">${me?.ready?'取消准备':'准备'}</button>${host?`<button class="btn primary" data-do="start" ${room.players.length<capacity||room.players.some(p=>!p.ready)?'disabled':''}>开始游戏</button>`:''}`}<button class="btn secondary" data-do="leave">${room.matchmaking?'取消匹配':'离开房间'}</button></div>`:state.replay?'':game.phase==='finished'?`<div class="controls"><button class="btn primary" data-do="leave">返回大厅</button></div>`:`${actionPanel(game)}<div class="controls">${game.canExplode?'<button class="btn danger small" data-do="explode">狼人自爆</button>':''}${state.demo?'<button class="btn secondary small" data-do="demo-next">跳到本阶段结算</button><button class="btn secondary small" data-do="leave">退出试玩</button>':''}</div>`}
  </div><div class="game-right">${chatPanel(room,'public')}${game&&(game.myRole==='wolf'||game.phase==='finished')?chatPanel(room,'wolf'):''}</div></div>`;
}
function privateInfo(g){const info=g.privateInfo||{};return `<div class="private-info">${info.results?.length?`<div class="alert info">查验结果：${info.results.map(r=>`${r.seat} 号 ${escape(r.name)} · ${r.team==='wolf'?'狼人':'好人'}`).join('；')}</div>`:''}${info.wolfTeammates?.length?`<p class="small muted">狼人同伴：${info.wolfTeammates.map(p=>`${p.seat} 号 ${escape(p.name)}`).join('、')}</p>`:''}${info.wolfVotes?.length?`<p class="small muted">队内选择：${info.wolfVotes.map(v=>`${g.players.find(p=>p.id===v.playerId)?.seat} 号 → ${v.targetId?(g.players.find(p=>p.id===v.targetId)?.seat+' 号'):'空刀'}`).join('；')}</p>`:''}${info.potions?`<p class="small muted">解药：${info.potions.save?'可用':'已用'} · 毒药：${info.potions.poison?'可用':'已用'}${g.phase==='witch'&&info.nightVictim?` · 今夜被袭击：${info.nightVictim.seat} 号 ${escape(info.nightVictim.name)}`:''}</p>`:''}</div>`;}
function actionPanel(g){
  if(!g.actionable)return `<div class="action-panel"><p>${g.submitted?(['guard','wolf','seer','witch'].includes(g.phase)?'已提交，等待本阶段倒计时结束。':'已提交，等待其他玩家完成行动。'):g.phase==='discussion'||g.phase==='lastwords'?'请等待轮到你发言。可以先在右侧输入草稿。':'等待本阶段结束，请留意倒计时。'}</p></div>`;
  if(g.phase==='discussion'||g.phase==='lastwords')return `<div class="action-panel"><strong>轮到你${g.phase==='lastwords'?'发表遗言':'发言'}了</strong><p>在发言框中输入内容，发言结束后点击下方按钮。</p><button class="btn primary" data-do="pass">结束发言</button></div>`;
  const targets=g.action?.targets||[];
  return `<div class="action-panel"><strong>${escape(g.phaseLabel)} · 选择目标</strong><div class="targets">${targets.map(p=>`<button class="target ${state.target===p.id?'selected':''}" data-target="${escape(p.id)}">${p.seat} 号 ${escape(p.name)}</button>`).join('')}</div><div class="controls">${g.phase==='witch'?`${g.action?.choices?.includes('save')?'<button class="btn primary" data-action="save">使用解药</button>':''}${g.action?.choices?.includes('poison')?`<button class="btn danger" data-action="poison" ${!state.target?'disabled':''}>对所选玩家用毒</button>`:''}`:`<button class="btn primary" data-action="confirm" ${!state.target?'disabled':''}>确认${g.phase==='vote'?'投票':'选择'}</button>`}<button class="btn secondary" data-action="skip">${g.phase==='vote'?'弃权':'放弃行动'}</button></div></div>`;
}
function chatPanel(room,channel){
  const g=room.game, isWolf=channel==='wolf', allowed=!state.replay&&(isWolf?Boolean(g?.canWolfChat):(!g||g.phase==='finished'||g.canSpeak));
  let entries=(room.messages||[]).filter(m=>(m.channel||'public')===channel).map(m=>({at:m.at||m.createdAt||0,html:`<div class="chat-message ${isWolf?'wolf-message':''}"><strong>${m.seat?m.seat+' 号 ':''}${escape(m.name||m.playerName||'玩家')}</strong> ${escape(m.text)}</div>`}));
  if(!isWolf)entries=entries.concat((g?.log||[]).map(l=>({at:l.at,html:`<div class="system-message">${escape(l.text)}</div>`}))).sort((a,b)=>a.at-b.at);
  return `<section class="card chat-card"><div class="card-header"><strong>${isWolf?'狼人队内频道':'发言记录'}</strong><small class="muted">${isWolf?'仅狼人夜间可见':'文字交流'}</small></div><div class="chat-feed" id="feed-${channel}">${entries.length?entries.map(e=>e.html).join(''):'<p class="muted small">暂无发言记录。</p>'}</div>${!state.replay?`<form class="chat-form" data-chat="${channel}"><textarea class="input chat-input" id="draft-${channel}" aria-label="${isWolf?'狼人队内消息':'发言内容'}" maxlength="500" rows="3" placeholder="${allowed?'输入你的发言…':'可以先写草稿，轮到你时再发送…'}">${escape(isWolf?state.wolfDraft:state.draft)}</textarea><div class="chat-actions"><small class="muted">${allowed?'可以发言':'当前不能发送'} · 最多 500 字</small><button class="btn primary small" type="submit" ${allowed?'':'disabled'}>发送</button></div></form>`:''}</section>`;
}
function render(){
  const focus=document.activeElement?.id, value=focus?document.activeElement.value:null, caret=focus?document.activeElement.selectionStart:null;
  const scrolls={};document.querySelectorAll('.chat-feed').forEach(x=>scrolls[x.id]={top:x.scrollTop,bottom:x.scrollHeight-x.scrollTop-x.clientHeight<40});
  const body=state.page==='room'?roomView():state.page==='rules'?`<div class="section-heading"><h1>游戏规则</h1></div><section class="card"><div class="card-body">${rules()}</div></section>`:state.page==='history'?`<div class="section-heading"><h1>对局历史</h1><button class="link-button" data-do="refresh">刷新</button></div><section class="card">${historyTable([...state.demoHistory,...state.history])}</section>`:lobby();
  $('#app').innerHTML=shell(body);updateClock();
  if(focus){const el=document.getElementById(focus);if(el){el.value=value;el.focus({preventScroll:true});if(caret!==null&&el.setSelectionRange)try{el.setSelectionRange(caret,caret);}catch{}}}
  document.querySelectorAll('.chat-feed').forEach(x=>{const old=scrolls[x.id];x.scrollTop=!old||old.bottom?x.scrollHeight:old.top;});
}
function updateClock(){document.querySelectorAll('[data-deadline]').forEach(x=>{const sec=Math.max(0,Math.ceil((+x.dataset.deadline-Date.now())/1000));x.textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;x.classList.toggle('urgent',sec<=15);});}

async function request(path,data,options={}){
  const response=await fetch(state.apiBase+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'Content-Type':'application/json'}),...(state.token?{'Authorization':`Bearer ${state.token}`}:{})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(8000),...options});
  const body=await response.json().catch(()=>({error:'服务器返回了无效响应'}));
  if(!response.ok)throw Object.assign(new Error(body.error||'请求失败'),{status:response.status});return body;
}
async function connect({quiet=false}={}){
  if(connectPromise)return connectPromise;
  connectPromise=(async()=>{
    if(!quiet)state.checking=true;
    state.online=false;networkRevision++;render();
    state.token=sessionStore.get('token:'+state.apiBase);
    try{
      const health=await request('/api/health');if(health.ok!==true||health.service!=='moonwolf')throw new Error('没有找到狼人杀联机服务');
      let s;
      try{s=await request('/api/session',state.token?{}:{name:state.name});}
      catch(error){if(error.status!==401)throw error;state.token='';sessionStore.set('token:'+state.apiBase,'');s=await request('/api/session',{name:state.name});}
      state.token=s.token;state.player=s.player;state.name=s.player.name;storage.set('name',state.name);sessionStore.set('token:'+state.apiBase,s.token);state.online=true;state.pollFailures=0;state.connectError='';retryDelay=5000;
      // Reconcile the authoritative room after reconnect, even if its contents equal
      // the old JSON snapshot; local replay/demo state must not replace it.
      lastRoomJson='';await refreshData(true);
      if(state.pendingInvite&&!inviteShown&&!state.modal&&state.online){inviteShown=true;if(state.room?.code===state.pendingInvite){state.page='room';clearInvite();}else joinModal(state.pendingInvite);}
    }catch(e){state.online=false;state.connectError=e.message;nextReconnectAt=Date.now()+retryDelay;retryDelay=Math.min(retryDelay*2,30000);}
    finally{state.checking=false;render();}
  })();
  try{return await connectPromise;}finally{connectPromise=null;}
}
async function refreshData(force=false){
  if(!state.online||state.demo||pollLock)return;pollLock=true;
  const revision=networkRevision;
  try{
    const r=await request('/api/room');if(revision!==networkRevision||state.demo)return;let changed=false;const json=JSON.stringify(r.room);
    if(json!==lastRoomJson){state.room=r.room;lastRoomJson=json;changed=true;}
    if(force||++historyTick%6===0){
      const results=await Promise.allSettled([request('/api/rooms'),request('/api/history'),request('/api/stats')]);
      if(revision!==networkRevision||state.demo)return;
      if(results[0].status==='fulfilled')state.rooms=results[0].value.rooms||[];
      if(results[1].status==='fulfilled')state.history=results[1].value.history||results[1].value.games||[];
      if(results[2].status==='fulfilled')state.standings=results[2].value.standings||[];
      changed=true;
    }
    if(state.pollFailures){state.pollFailures=0;changed=true;}
    if(changed)render();
  }catch(e){if(revision!==networkRevision)return;state.pollFailures++;if(e.status===401||state.pollFailures>=3){state.online=false;nextReconnectAt=Date.now()+1000;toast('连接中断，正在恢复会话');render();}}finally{pollLock=false;}
}
function ensureOnline(){if(state.demo)throw new Error('请先退出本地试玩，再使用联机功能');if(!state.online)throw new Error('正在恢复联机连接，请稍后重试，或点击「立即重连」');}
async function mutation(path,data={}){ensureOnline();networkRevision++;try{const r=await request(path,data);networkRevision++;if('room'in r){state.room=r.room;lastRoomJson=JSON.stringify(r.room);}render();return r;}catch(error){if(error.status===401){state.online=false;nextReconnectAt=Date.now()+1000;render();}throw error;}}
function settingsModal(){modal('联机设置',`<p class="muted">填写游戏服务器的完整地址。所有玩家使用同一服务器，即可共享匹配队列与房间。</p><form id="settings-form"><label class="field"><span>服务器地址</span><input id="api-base" class="input" type="url" value="${escape(state.apiBase)}" placeholder="https://your-server.example.com"><small class="muted">留空会尝试连接当前网站的服务器。</small></label><p class="form-error" id="settings-error"></p><button class="btn primary" type="submit">保存并连接</button></form>`);}
function profileModal(){modal('设置玩家昵称',`<form id="profile-form"><label class="field"><span>昵称（1–16 字）</span><input class="input" id="player-name" value="${escape(state.name)}" maxlength="16" required></label><p class="small muted">同一浏览器标签页会保留你的座位；游戏进行中不能修改昵称。</p><p class="form-error" id="profile-error"></p><button class="btn primary" type="submit">保存昵称</button></form>`);}
function joinModal(code=state.pendingInvite||''){modal(code?'加入好友房间':'输入房号加入',`<form id="join-form"><label class="field"><span>6 位随机房号</span><input class="input room-code-input" id="join-code" name="code" value="${escape(code)}" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="请输入 6 位数字" required></label><p class="small muted">你将以「${escape(state.name)}」加入。可在页面右上角修改昵称。</p><p class="form-error" id="join-error"></p><button class="btn primary full" type="submit">加入房间</button></form>`);}
function createModal(){state.config=copy(STANDARD_CONFIG);modal('自选配置开房',`<form id="create-form"><label class="field"><span>房间名称</span><input id="room-name" class="input" value="${escape(state.name)}的房间" maxlength="30" required></label><div class="config-total"><strong>角色配置 · 共 <span id="total-count">12</span> 人</strong><button type="button" class="link-button" data-do="reset-config">恢复标准局</button></div><div class="role-counters">${roleKeys.map(r=>`<div class="counter-item"><span>${badge(r)}</span><button type="button" data-count="${r}" data-delta="-1" aria-label="减少${ROLE_INFO[r].name}">−</button><output id="count-${r}">${state.config.roles[r]}</output><button type="button" data-count="${r}" data-delta="1" aria-label="增加${ROLE_INFO[r].name}">＋</button></div>`).join('')}</div><div class="form-row"><label class="field"><span>房间类型</span><select id="visibility" class="input"><option value="private">私密房间 · 凭房号加入</option><option value="public">公开房间 · 展示在大厅</option></select></label><label class="field"><span>胜利条件</span><select id="victory" class="input"><option value="side">屠边（标准）</option><option value="all">屠城</option></select></label></div><div class="form-row"><label class="field"><span>夜间行动时限</span><select id="night-seconds" class="input"><option value="30">30 秒</option><option value="45" selected>45 秒</option><option value="60">60 秒</option></select></label><label class="field"><span>每人发言时限</span><select id="day-seconds" class="input"><option value="60">60 秒</option><option value="90" selected>90 秒</option><option value="120">120 秒</option></select></label></div><p class="small muted">6–18 人，神职各最多 1 人；狼人至少 1 人且少于半数。创建后自动生成不重复的 6 位房号。</p><p class="form-error" id="create-error"></p><button class="btn primary full" type="submit">创建房间</button></form>`);}
function updateCounts(){roleKeys.forEach(r=>{const el=$('#count-'+r);if(el)el.textContent=state.config.roles[r];});if($('#total-count'))$('#total-count').textContent=size(state.config);}

function startDemo(){
  if(state.room&&!state.demo){toast('你已在联机房间中，请先离开房间');return;}
  networkRevision++;
  state.demo=true;state.replay=null;state.player={id:'local-player',name:state.name};
  const names=['青木','晚风','小橘','长夜','白露','星河','南山','知秋','浮云','阿月','听雨'];
  const players=[{id:'local-player',name:state.name,seat:1,ready:true},...names.map((name,i)=>({id:'bot-'+i,name:'电脑·'+name,seat:i+2,ready:true}))];
  state.demoGame=createGame(players,STANDARD_CONFIG);state.room={code:String(Math.floor(100000+Math.random()*900000)),name:'本地试玩',hostId:'local-player',config:copy(STANDARD_CONFIG),visibility:'private',players,messages:[],game:viewGame(state.demoGame,'local-player')};state.page='room';state.draft='';state.wolfDraft='';closeModal();render();
}
function syncDemo(){state.room.game=viewGame(state.demoGame,'local-player');if(state.demoGame.phase==='finished'&&!state.demoHistory.some(x=>x.code===state.room.code)){state.demoHistory.unshift({code:state.room.code,name:state.room.name,winner:state.demoGame.winner,round:state.demoGame.round,endedAt:Date.now(),demo:true,room:copy(state.room)});}render();}
function demoTick(){
  if(!state.demo||!state.demoGame||state.demoGame.phase==='finished')return;
  const g=state.demoGame, before=JSON.stringify(g);advance(g,Date.now());
  if(Date.now()-botTimer>1800){botTimer=Date.now();
    for(const p of g.players.filter(p=>p.id!=='local-player')){
      const v=viewGame(g,p.id);if(!v.actionable||v.submitted)continue;
      try{if(v.phase==='discussion'||v.phase==='lastwords'){
        state.room.messages.push({name:p.name,seat:p.seat,at:Date.now(),channel:'public',text:v.phase==='lastwords'?'我的遗言结束。请继续推理。':'这是随机行动的试玩电脑。我发言结束。'});act(g,p.id,{type:'pass'},Date.now());break;
      }else{const target=v.action?.targets?.length?v.action.targets[Math.floor(Math.random()*v.action.targets.length)].id:null;act(g,p.id,{type:v.phase,targetId:v.phase==='witch'?null:target,choice:v.phase==='witch'?'skip':undefined},Date.now());}}
      catch(e){console.warn('Demo action:',e.message);}
    }
    if(['guard','wolf','seer','witch'].includes(g.phase)){
      const remaining=g.players.some(p=>viewGame(g,p.id).actionable&&!viewGame(g,p.id).submitted);
      if(!remaining){g.deadline=Date.now()-1;advance(g,Date.now());}
    }
  }
  if(JSON.stringify(g)!==before)syncDemo();
}
async function submitAction(payload){if(state.demo){act(state.demoGame,'local-player',payload,Date.now());state.target=null;syncDemo();}else{await mutation('/api/action',payload);state.target=null;}}
function clearInvite(){state.pendingInvite=null;const url=new URL(location.href);if(url.searchParams.has('room')){url.searchParams.delete('room');history.replaceState(null,'',url);}}
function invitationUrl(code){const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('room',code);return url.href;}
async function joinRoom(code){if(!/^[0-9]{6}$/.test(code))throw new Error('请输入 6 位数字房号');await mutation('/api/join',{code});clearInvite();closeModal();state.page='room';state.replay=null;render();}
async function navigate(page){state.replay=null;state.page=page;render();if(page==='history'||page==='lobby')await refreshData(true);}

document.addEventListener('click',async event=>{
  const b=event.target.closest('button,a[data-page]');if(!b)return;
  if(b.dataset.page){event.preventDefault();await navigate(b.dataset.page);return;}
  if(b.dataset.count){const r=b.dataset.count;state.config.roles[r]=Math.max(0,Math.min(r==='wolf'?6:r==='villager'?12:1,state.config.roles[r]+Number(b.dataset.delta)));updateCounts();return;}
  if(b.dataset.target){state.target=b.dataset.target;render();return;}
  if(state.busy)return;
  state.busy=true;b.disabled=true;
  try{
    if(b.dataset.join)await joinRoom(b.dataset.join);
    else if(b.dataset.history){const local=state.demoHistory.find(g=>g.code===b.dataset.history);state.replay=local?local.room:(await request('/api/history/'+encodeURIComponent(b.dataset.history))).room;state.page='room';render();}
    else if(b.dataset.action){const a=b.dataset.action,g=state.room?.game;await submitAction({type:g.phase,targetId:a==='skip'||a==='save'?null:state.target,choice:g.phase==='witch'?(a==='skip'?'skip':a):undefined});}
    else switch(b.dataset.do){
      case'close-modal':closeModal();break;
      case'profile':profileModal();break;
      case'settings':settingsModal();break;
      case'reconnect':await connect();toast(state.online?'联机连接已恢复':'暂时无法连接，将继续自动重试');break;
      case'join-modal':joinModal();break;
      case'create':createModal();break;
      case'reset-config':state.config=copy(STANDARD_CONFIG);updateCounts();break;
      case'refresh':await refreshData(true);toast('已刷新');break;
      case'match':await mutation('/api/match');state.page='room';state.replay=null;render();break;
      case'ready':await mutation('/api/ready',{ready:!state.room.players.find(p=>p.id===state.player.id)?.ready});break;
      case'start':await mutation('/api/start');break;
      case'leave':if(state.demo){state.demo=false;state.demoGame=null;state.room=null;state.page='lobby';await connect();}else{await mutation('/api/leave');state.page='lobby';render();await refreshData(true);}break;
      case'copy-room':try{await navigator.clipboard.writeText(state.room.code);toast('房号已复制：'+state.room.code);}catch{toast('房号：'+state.room.code);}break;
      case'copy-invite':{const link=invitationUrl(state.room.code);try{await navigator.clipboard.writeText(link);toast('邀请链接已复制，发给朋友即可加入');}catch{modal('邀请好友',`<p class="muted">将下面的链接发给朋友，或分享房号 ${escape(state.room.code)}。</p><label class="field"><span>邀请链接</span><input class="input" value="${escape(link)}" readonly aria-label="邀请链接"></label>`);}break;}
      case'pass':await submitAction({type:'pass'});break;
      case'explode':modal('确认狼人自爆',`<p>自爆会公开你的狼人身份，你将立即出局并结束当天发言与投票。</p><button class="btn danger" data-do="confirm-explode">确认自爆</button> <button class="btn secondary" data-do="close-modal">取消</button>`);break;
      case'confirm-explode':await submitAction({type:'explode'});closeModal();break;
      case'demo':startDemo();break;
      case'demo-next':state.demoGame.deadline=Date.now()-1;advance(state.demoGame,Date.now());syncDemo();break;
    }
  }catch(e){toast(e.message);}finally{state.busy=false;if(b.isConnected)b.disabled=false;}
});

document.addEventListener('input',event=>{if(event.target.id==='draft-public')state.draft=event.target.value;if(event.target.id==='draft-wolf')state.wolfDraft=event.target.value;});
document.addEventListener('submit',async event=>{
  event.preventDefault();const f=event.target;if(state.busy)return;state.busy=true;const submit=f.querySelector('[type="submit"]');if(submit)submit.disabled=true;
  try{
    if(f.id==='settings-form'){
      let url=$('#api-base').value.trim().replace(/\/$/,'');if(url){const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('请填写不含路径、账户或参数的 HTTP(S) 地址');if(u.pathname!=='/')throw new Error('只需填写服务器域名，不需要 /api 路径');if(location.protocol==='https:'&&u.protocol!=='https:')throw new Error('当前网站使用 HTTPS，服务器也需要 HTTPS');}
      if(connectPromise)throw new Error('正在连接，请稍候再保存');
      if(state.room&&!state.demo&&url!==state.apiBase)throw new Error('请先离开当前房间，再更换服务器');const sameServer=url===state.apiBase;state.apiBase=url;storage.set('apiBase',url);state.demo=false;if(!sameServer){state.room=null;state.rooms=[];state.history=[];state.standings=[];state.page='lobby';}closeModal();await connect();toast(state.online?'连接成功':'连接失败，将继续自动重试；请检查地址、HTTPS 和后端跨域配置');
    }else if(f.id==='profile-form'){
      const name=$('#player-name').value.trim();if(!name||name.length>16)throw new Error('昵称需要 1–16 字');if(state.room?.game&&state.room.game.phase!=='finished')throw new Error('对局中不能修改昵称');if(state.online&&!state.demo){const s=await request('/api/session',{name});state.player=s.player;state.token=s.token;sessionStore.set('token:'+state.apiBase,s.token);}state.name=name;storage.set('name',name);closeModal();render();
    }else if(f.id==='create-form'){
      const config=validateConfig({...state.config,victory:$('#victory').value,nightSeconds:+$('#night-seconds').value,daySeconds:+$('#day-seconds').value});await mutation('/api/rooms',{name:$('#room-name').value.trim(),config,visibility:$('#visibility').value});closeModal();state.replay=null;state.page='room';render();
    }else if(f.id==='join-form'||f.id==='quick-join'){await joinRoom(new FormData(f).get('code').trim());}
    else if(f.dataset.chat){
      const channel=f.dataset.chat,text=(channel==='wolf'?state.wolfDraft:state.draft).trim();if(!text)throw new Error('请输入发言内容');
      if(state.demo){const g=state.room.game;if(g.phase!=='finished'&&!(channel==='wolf'?g.canWolfChat:g.canSpeak))throw new Error('当前不能发送消息');state.room.messages.push({name:state.name,seat:1,text,channel,at:Date.now()});}
      else await mutation('/api/chat',{text,channel});
      if(channel==='wolf')state.wolfDraft='';else state.draft='';const field=$('#draft-'+channel);if(field)field.value='';render();
    }
  }catch(e){const error=f.querySelector('.form-error');if(error)error.textContent=e.message;else toast(e.message);}finally{state.busy=false;if(submit?.isConnected)submit.disabled=false;}
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')closeModal();
  if(e.key==='Tab'&&state.modal){const list=[...document.querySelectorAll('.modal button,.modal input,.modal select,.modal textarea')].filter(x=>!x.disabled);if(!list.length)return;const first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
});
setInterval(()=>{updateClock();demoTick();},500);
setInterval(()=>{if(state.demo)return;if(state.online)refreshData();else if(!state.checking&&!connectPromise&&Date.now()>=nextReconnectAt)connect({quiet:true});},1500);
window.addEventListener('online',()=>{if(!state.demo&&!state.online)connect({quiet:true});});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!state.demo){if(state.online)refreshData(true);else connect({quiet:true});}});
render();connect();
