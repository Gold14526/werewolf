import {STANDARD_CONFIG, ROLE_INFO, isWolfRole, validateConfig, createGame, viewGame, act, advance} from './engine.js';
import {PROBLEM_TITLE, PROBLEM_CONTENT_HTML} from './problem-content.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy = value => structuredClone(value);
const storage = {get(key, fallback=''){try{return localStorage.getItem(`moonwolf:${key}`) ?? fallback;}catch{return fallback;}},set(key,value){try{localStorage.setItem(`moonwolf:${key}`,value);}catch{}}};
const roleKeys = Object.keys(ROLE_INFO);
const size = config => Object.values(config.roles).reduce((a,b)=>a+b,0);
const sessionStore = {get(key){try{return sessionStorage.getItem(`moonwolf:${key}`)||'';}catch{return '';}},set(key,val){try{sessionStorage.setItem(`moonwolf:${key}`,val);}catch{}}};
const defaultApi = (window.MOONWOLF_CONFIG?.apiBase || '').replace(/\/+$/, '');
const state = {
  problemTab:'description', submitTab:'code', codeDraft:storage.get('codeDraft',''), codeLanguage:storage.get('codeLanguage','cpp17'), codeSelection:{start:0,end:0,top:0,left:0},
  page:'lobby', name:storage.get('name','玩家'+Math.floor(1000+Math.random()*9000)),
  apiBase:(storage.get('apiBase') || defaultApi).replace(/\/+$/,''),
  token:'', player:null, online:false, checking:true, room:null, rooms:[], history:[], standings:[],
  demo:false, demoGame:null, demoHistory:[], replay:null, target:null, actionKey:'', draft:'', wolfDraft:'',
  config:copy(STANDARD_CONFIG), modal:null, skill:null, busy:false, pollFailures:0,
  pendingInvite: /^\d{6}$/.test(new URL(location.href).searchParams.get('room')||'') ? new URL(location.href).searchParams.get('room') : null,
};
storage.set('name',state.name);
const badge = role => `<span class="badge ${isWolfRole(role)?'wolf':role==='villager'?'villager':'god'}">${escape(ROLE_INFO[role]?.name||role)}</span>`;
const roleTags = config => roleKeys.filter(r=>config.roles[r]).map(r=>`<span class="badge ${isWolfRole(r)?'wolf':r==='villager'?'villager':'god'}">${config.roles[r]} ${escape(ROLE_INFO[r].name)}</span>`).join(' ');
const resultLabel = winner => winner==='wolf'?'狼人胜利':winner==='good'?'好人胜利':'平局';
const formatTime = at => at ? new Date(at).toLocaleString('zh-CN',{hour12:false}) : '—';
let toastTimer, lastRoomJson='', pollLock=false, botTimer=0, nextPollAt=0, lastLobbyRefreshAt=0;
let connectPromise=null, nextReconnectAt=0, retryDelay=5000, networkRevision=0, inviteShown=false;

function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
function modal(title,body){state.modal=title;$('#modal-root').innerHTML=`<div class="overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${title}</h2><button class="close" data-do="close-modal" aria-label="关闭">×</button></div><div class="modal-body">${body}</div></section></div>`;setTimeout(()=>$('.modal input,.modal button,.modal select')?.focus(),0);}
function closeModal(){state.modal=null;state.skill=null;$('#modal-root').innerHTML='';}
function rules(){return `<ol class="rules-list">
  <li><strong>身份：</strong>默认 12 人标准局，${roleTags(STANDARD_CONFIG)}。开局随机分配身份；狼人知道同伴，其他玩家只知道自己。</li>
  <li><strong>天黑：</strong>守卫、狼人、预言家、女巫依次行动。狼人可在队内频道讨论，选择袭击目标；预言家独自获知查验结果。已配置的夜间阶段保留固定时长，不因对应身份出局而跳过。未操作至超时视为放弃。</li>
  <li><strong>女巫与守卫：</strong>女巫一瓶解药、一瓶毒药，每夜最多一瓶，仅首夜能自救；守卫不能连续守同一人。同守同救仍会死亡。</li>
  <li><strong>天亮：</strong>公布死亡玩家，不公开身份。首夜死者可发表遗言；随后存活玩家依次发言，只有当前玩家可以发送，可点击「结束发言」。未轮到时可先写草稿。</li>
  <li><strong>投票：</strong>具有投票权的存活玩家同时投票，可弃权，不能投自己；警长放逐票计 1.5 票。投票结束后公布票型；平票玩家再发言并重新投票，再次平票则无人出局。</li>
  <li><strong>猎人：</strong>被袭击或放逐后可开枪带走一人；被女巫毒杀或白狼王带走不能开枪。<strong>狼人自爆：</strong>普通狼人和狼王可在白天发言、投票或警上发言时自爆，立即出局并结束当天。</li>
  <li><strong>狼王与白狼王：</strong>两者都参与夜间袭击和狼人队内交流。狼王出局可开枪，但被毒杀、自爆、骑士决斗或白狼王带走时不能开枪。白狼王仅在白天或警上发言阶段可自爆并带走一名玩家，也可选择只自爆；非自爆出局不能带人。白狼王及其带走的玩家没有遗言，被带走者不能发动死亡技能。</li>
  <li><strong>愚者：</strong>首次被投票放逐时翻牌免死，仍可发言，之后不能投票，也不能再被投票放逐；夜间袭击、毒药和技能仍可使其出局。翻牌时若持有警徽，警徽流失。</li>
  <li><strong>骑士：</strong>白天发言阶段可发动一次决斗。目标是狼人则目标出局并直接进入黑夜；目标是好人则目标存活、骑士出局，继续白天流程。</li>
  <li><strong>上警：</strong>建房时可勾选开启。首夜结束后先竞选警长，再公布死讯；首夜被袭击的玩家也能参加竞选。报名上警后依次发言，可在投票开始前退水；只有本轮未报名的警下玩家投票，退水玩家不能投票。平票加赛一次，再次平票或全员弃票则本局无警长。警长可选择白天发言方向，并在常规白天最后发言，放逐票计 1.5 票；出局时可移交警徽或撕毁，超时视为撕毁。警上发言期间狼人自爆会中止竞选并使警徽流失，结算首夜死讯后直接进入下一夜。</li>
  <li><strong>胜负：</strong>狼人全部出局则好人获胜。默认屠边：村民全部出局或神职全部出局，狼人获胜；自定义可选屠城，须淘汰所有好人。超过 20 夜判平局。</li>
  <li><strong>复盘：</strong>结束后公开所有身份，可查看发言、夜间行动和队内聊天。私密房间的记录仅参与者可查看。本版为文字游戏，房间配置与完整进度均由联机服务保存。</li>
</ol>`;}

function uiIcon(name){
  const paths={home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',problem:'<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',history:'<path d="M4 5h16v16H4zM8 2v6M16 2v6M4 10h16M8 14h3M8 17h7"/>',rules:'<path d="M12 6c-3-3-7-2-9-1v15c3-2 6-2 9 0 3-2 6-2 9 0V5c-2-1-6-2-9 1zM12 6v14"/>',settings:'<path d="m10 2-.6 2.5-2.1 1.2L4.8 5l-2 3.5 1.9 1.8v2.4l-1.9 1.8 2 3.5 2.5-.7 2.1 1.2.6 2.5h4l.6-2.5 2.1-1.2 2.5.7 2-3.5-1.9-1.8v-2.4l1.9-1.8-2-3.5-2.5.7-2.1-1.2L14 2z"/><circle cx="12" cy="11.5" r="3"/>',submit:'<path d="M5 3h10l4 4v7M14 3v5h5M5 3v18h7M17 14v8M13 18l4-4 4 4"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H4v13h4"/>'};
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name]||paths.problem}</svg>`;
}
function shell(content){return `<aside class="lg-rail" aria-label="主导航"><button data-page="lobby" class="${state.page==='lobby'?'active':''}" aria-label="首页" title="首页"><span class="lg-rail-icon">${uiIcon('home')}</span><small>首页</small></button><button data-page="room" class="${state.page==='room'?'active':''}" aria-label="题库与我的房间" title="题库与我的房间"><span class="lg-rail-icon">${uiIcon('problem')}</span><small>题库</small></button><button data-page="history" class="${state.page==='history'?'active':''}" aria-label="对局记录" title="对局记录"><span class="lg-rail-icon">${uiIcon('history')}</span><small>记录</small></button><button data-page="rules" class="${state.page==='rules'?'active':''}" aria-label="游戏规则" title="游戏规则"><span class="lg-rail-icon">${uiIcon('rules')}</span><small>规则</small></button><button data-do="settings" aria-label="联机设置" title="联机设置"><span class="lg-rail-icon">${uiIcon('settings')}</span><small>设置</small></button></aside>
  <header class="lg-topbar"><button class="lg-topbar-brand" data-page="lobby" aria-label="题目首页"><img src="./assets/luogu.ico" alt="洛谷" width="36" height="36"></button><div class="lg-breadcrumb"><button class="link-button" data-page="lobby">题目列表</button><span aria-hidden="true"> / </span><span>P4899</span></div><button class="account" data-do="profile"><span class="lg-profile-avatar">${escape(state.name.slice(0,1))}</span>${escape(state.name)}</button></header>
  <div class="lg-page">${connectionBanner()}${content}<footer class="footer">P4899 · [IOI 2018] werewolf 狼人 <button class="link-button" data-page="rules">规则说明</button></footer></div>`;}

function historyTable(list,empty='暂无已结束的对局'){return `<div class="table-wrap"><table class="table"><thead><tr><th>对局</th><th>结果</th><th>天数</th><th>结束时间</th></tr></thead><tbody>${list.length?list.map(g=>`<tr><td><button class="link-button history-link" data-history="${escape(g.code)}">#${escape(g.code)}</button>${g.demo?' <small class="muted">试玩</small>':''}</td><td><span class="badge ${g.winner==='wolf'?'wolf':g.winner==='good'?'good':'villager'}">${resultLabel(g.winner)}</span></td><td>${escape(g.round)}</td><td>${formatTime(g.endedAt)}</td></tr>`).join(''):`<tr><td colspan="4" class="empty-row">${empty}</td></tr>`}</tbody></table></div>`;}
const NIGHT_PHASES=['guard','wolf','seer','witch'];
const CODE_LANGUAGES=[['cpp14','C++14'],['cpp17','C++17'],['cpp20','C++20'],['c','C'],['python3','Python 3'],['java17','Java 17'],['rust','Rust'],['javascript','JavaScript']];
function syncActionKey(room){
  const g=room?.game,key=g?`${g.round}:${g.phase}:${g.currentSpeakerId||''}:${g.deadline}`:'';
  if(state.actionKey!==key){state.actionKey=key;state.target=null;if(state.skill){const submitted=state.skill.submitting;closeModal();if(!submitted)toast('阶段已变化，请重新选择技能目标');}}
}
function problemPage(room){
  syncActionKey(room);
  return `<header class="lg-problem-header"><h1>${escape(PROBLEM_TITLE)}</h1><div class="lg-problem-stats"><span class="lg-stat"><span>提交</span><strong>5.29k</strong></span><span class="lg-stat"><span>通过</span><strong>2.59k</strong></span><span class="lg-stat"><span>时间限制</span><strong>4.00s</strong></span><span class="lg-stat"><span>内存限制</span><strong>537.00MB</strong></span></div></header>
  <nav class="lg-problem-tabs" aria-label="题目页签"><button class="${state.problemTab==='description'?'active':''}" data-problem-tab="description" aria-pressed="${state.problemTab==='description'}">题目描述</button><button class="${state.problemTab==='submit'?'active':''}" data-problem-tab="submit" aria-pressed="${state.problemTab==='submit'}">提交答案</button></nav>
  <div class="lg-layout"><main class="lg-main">${state.problemTab==='submit'?submissionView(room):`<section class="lg-card lg-background"><h2>题目背景</h2><p class="lg-background-intro">你是狼人，还是人类？</p>${room?roomBackground(room):lobbyBackground()}</section><article class="lg-card lg-statement lg-statement-connected">${PROBLEM_CONTENT_HTML}</article>`}</main><aside class="lg-sidebar">${problemMeta()}<div class="lg-discussion">${room?chatPanel(room,'public'):`<section class="lg-card chat-card"><div class="card-header"><strong>相关讨论</strong></div><div class="chat-feed"><p class="muted small">加入房间后，这里会显示白天发言与对局记录。</p></div><div class="card-body"><button class="btn primary small" data-do="join-modal">输入房号加入</button></div></section>`}</div></aside></div>`;
}
function problemMeta(){return `<section class="lg-card lg-problem-meta"><div class="lg-meta-row"><span>题目编号</span><strong>P4899</strong></div><div class="lg-meta-row"><span>提供者</span><span class="lg-provider">Imagine</span></div><div class="lg-meta-row"><span>难度</span><strong class="lg-difficulty">省选/NOI−</strong></div><div class="lg-meta-row"><span>历史分数</span><span>暂无</span></div><div class="lg-reference-links"><button class="link-button" data-page="history">${uiIcon('history')}<span>查看提交记录</span></button><button class="link-button" data-page="rules">${uiIcon('rules')}<span>查看游戏规则</span></button></div><div class="lg-reference-actions"><button class="btn primary small" data-problem-tab="submit">${uiIcon('submit')}提交答案</button><button class="btn secondary small" data-do="join-modal">加入房间</button></div></section><section class="lg-card lg-problem-tags"><h3>标签</h3><div class="lg-tags"><span class="lg-tag-source">IOI</span><span class="lg-tag-year">2018</span><span class="lg-tag-feature">O2 优化</span></div></section>`;}

function lobby(){return problemPage(null);}
function lobbyBackground(){return `<div class="seats">${Array.from({length:12},(_,i)=>`<div class="seat empty"><span class="seat-number">${i+1}</span><div class="avatar">＋</div><div class="seat-name muted">等待加入</div></div>`).join('')}</div><div class="lg-game-toolbar"><span class="small muted">默认 12 人标准局 · 6 位随机房号</span><button class="link-button" data-page="rules">玩法说明</button></div><div class="controls">${state.room?'<button class="btn primary" data-page="room">回到我的房间</button>':'<button class="btn primary" data-do="match">开始匹配</button>'}<button class="btn secondary" data-do="create">自选配置开房</button><button class="btn secondary" data-do="join-modal">输入房号加入</button><button class="btn secondary" data-do="demo">本地试玩</button></div><p class="small muted">匹配满 12 人自动开局，自建房由房主在全员准备后开始。</p><details class="lg-public-rooms"><summary>公开房间 · ${state.rooms.length} 个</summary><div class="lg-game-toolbar"><button class="link-button" data-do="refresh">刷新房间</button></div><div class="table-wrap"><table class="table"><thead><tr><th>房号</th><th>房间名</th><th>人数</th><th></th></tr></thead><tbody>${state.rooms.length?state.rooms.map(r=>`<tr><td>${escape(r.code)}</td><td>${escape(r.name)}</td><td>${r.playerCount} / ${r.capacity}</td><td><button class="btn primary small" data-join="${escape(r.code)}">加入</button></td></tr>`).join(''):'<tr><td colspan="4" class="empty-row">暂无等待中的公开房间</td></tr>'}</tbody></table></div></details><details class="lg-public-rooms"><summary>胜场榜</summary><div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>玩家</th><th>胜 / 局</th><th>胜率</th></tr></thead><tbody>${state.standings.length?state.standings.slice(0,20).map((p,i)=>`<tr><td>${i+1}</td><td>${escape(p.name)}</td><td>${p.wins} / ${p.games}</td><td>${(p.games?p.wins/p.games*100:0).toFixed(1)}%</td></tr>`).join(''):'<tr><td colspan="4" class="empty-row">完成第一局后生成战绩</td></tr>'}</tbody></table></div></details>`;}
function roomView(){return problemPage(state.replay||state.room);}
function availableTarget(g,id){
  if(state.replay||!g?.actionable||g.submitted||!g.action?.targets?.some(p=>p.id===id))return false;
  if(['vote','sheriff_vote'].includes(g.phase)){
    const p=g.players.find(p=>p.id===id);
    return Boolean(p&&p.id!==state.player?.id&&p.alive!==false&&!p.foolRevealed);
  }
  return true;
}
function selectTarget(id){const g=state.room?.game;if(!availableTarget(g,id))return false;syncActionKey(state.room);state.target=id;render();return true;}
function roomBackground(room){
  const game=room.game,myId=state.player?.id,me=room.players.find(p=>p.id===myId),host=room.hostId===myId;
  const players=game?.players||room.players,capacity=size(room.config),current=game?.players.find(p=>p.id===game.currentSpeakerId),voting=['vote','sheriff_vote'].includes(game?.phase);
  return `<div class="lg-game-toolbar"><strong>${state.replay?'对局回放':'房间'} #${escape(room.code)}</strong><div><button class="link-button" data-page="lobby">大厅</button> · <button class="link-button" data-page="history">对局历史</button></div></div>${state.demo&&!state.replay?'<div class="alert warning">本地试玩 · 其余座位为随机行动的电脑玩家。</div>':''}
  <div class="room-status"><div><strong class="status-title">${game?game.phase==='finished'?resultLabel(game.winner):`第 ${game.round} ${NIGHT_PHASES.includes(game.phase)?'夜':'天'} · ${escape(game.phaseLabel)}`:room.matchmaking?'匹配中，等待玩家加入':'等待玩家准备'}</strong><p class="status-detail">${game?game.phase==='finished'?'游戏结束，所有身份与记录已公开。':current?`当前由 ${current.seat} 号 ${escape(current.name)} ${game.phase==='lastwords'?'发表遗言':'发言'}。`:voting?'点击下方玩家头像选择目标，再确认投票。':NIGHT_PHASES.includes(game.phase)?'夜间行动请打开「提交答案 → 提交文件」。':'请根据身份提示操作，其他玩家等待。':`${escape(room.name)} · ${room.players.length} / ${capacity} 人 · ${room.visibility==='private'?'私密房间':'公开房间'}`}</p></div>${game?.deadline?`<strong class="timer" data-deadline="${game.deadline}"></strong>`:!game?`<div class="controls"><button class="btn secondary small" data-do="copy-room">复制房号</button><button class="btn primary small" data-do="copy-invite">复制邀请链接</button></div>`:''}</div>
  <div class="seats">${Array.from({length:capacity},(_,i)=>{
    const p=players.find(x=>x.seat===i+1);if(!p)return `<div class="seat empty"><span class="seat-number">${i+1}</span><div class="avatar">＋</div><div class="seat-name muted">等待加入</div></div>`;
    const ready=room.players.find(x=>x.id===p.id)?.ready,selectable=voting&&availableTarget(game,p.id),selected=selectable&&state.target===p.id;
    return `<div class="seat ${p.id===myId?'me':''} ${p.alive===false?'dead':''} ${p.id===game?.currentSpeakerId?'speaking':''} ${selected?'selected':''}"><span class="seat-number">${p.seat}</span><span class="seat-role">${p.role?badge(p.role):''}</span><button type="button" class="avatar lg-seat-button ${selected?'selected':''}" style="--avatar-hue:${(p.seat*47)%360}" ${selectable?`data-target="${escape(p.id)}"`:'disabled'} aria-label="${selectable?'选择投票目标：':''}${p.seat} 号 ${escape(p.name)}" aria-pressed="${selected}">${escape(p.name.slice(0,1))}</button><div class="seat-name">${escape(p.name)}${p.id===myId?'（你）':''}</div><div class="seat-status">${p.alive===false?'<span class="badge villager">出局</span>':game?p.id===game.currentSpeakerId?'<span class="badge good">正在发言</span>':'存活':ready?'<span class="badge good">已准备</span>':'未准备'}${p.id===game?.sheriffId?' <span class="badge sheriff">警长</span>':''}${p.foolRevealed?' <span class="badge villager">已翻牌 · 无投票权</span>':''}${p.id===room.hostId&&!game?' · 房主':''}</div></div>`;
  }).join('')}</div>${game?sheriffPanel(game):''}
  ${game?game.myRole&&!state.replay?`<div class="identity">你的身份：${badge(game.myRole)} <span class="small">${escape(ROLE_INFO[game.myRole]?.description)}</span></div>${privateInfo(game)}`:'':`<div class="config-tags">${roleTags(room.config)}</div><p class="small muted">${room.config.victory==='side'?'屠边':'屠城'} · 夜间 ${room.config.nightSeconds} 秒 · 每人发言 ${room.config.daySeconds} 秒 · ${room.config.sheriff?'开启上警':'不开启上警'}</p>`}
  ${!game?`<div class="controls">${room.matchmaking?'<span class="queue-count">满员后自动开始</span>':`<button class="btn ${me?.ready?'secondary':'primary'}" data-do="ready">${me?.ready?'取消准备':'准备'}</button>${host?`<button class="btn primary" data-do="start" ${room.players.length<capacity||room.players.some(p=>!p.ready)?'disabled':''}>开始游戏</button>`:''}`}<button class="btn secondary" data-do="leave">${room.matchmaking?'取消匹配':'离开房间'}</button></div>`:state.replay?'<div class="controls"><button class="btn secondary" data-do="night-actions">查看夜间记录</button></div>':game.phase==='finished'?`<div class="controls"><button class="btn primary" data-do="leave">返回大厅</button><button class="btn secondary" data-do="night-actions">查看夜间记录</button></div>`:`${NIGHT_PHASES.includes(game.phase)?'<div class="action-panel"><button class="btn primary" data-do="night-actions">提交答案 → 提交文件</button><p class="small muted">打开夜间行动区域，查看你的行动与队内交流。</p></div>':actionPanel(game)}<div class="controls">${game.canWithdraw?'<button class="btn secondary small" data-do="withdraw">退出竞选（退水）</button>':''}${game.canDuel?'<button class="btn danger small" data-do="duel">骑士决斗</button>':''}${game.canExplode?`<button class="btn danger small" data-do="explode">${game.myRole==='whiteWolfKing'?'白狼王自爆带人':'狼人自爆'}</button>`:''}${state.demo?'<button class="btn secondary small" data-do="demo-next">跳到本阶段结算</button><button class="btn secondary small" data-do="leave">退出试玩</button>':''}</div>`}`;
}
function submissionView(room){return `<section class="lg-card lg-submission"><nav class="lg-submit-tabs" aria-label="提交方式"><button class="${state.submitTab==='code'?'active':''}" data-submit-tab="code" aria-pressed="${state.submitTab==='code'}">提交代码</button><button class="${state.submitTab==='file'?'active':''}" data-submit-tab="file" aria-pressed="${state.submitTab==='file'}">提交文件</button></nav>${state.submitTab==='file'?nightActions(room):codeEditor()}</section>`;}
function codeLineNumbers(code){return Array.from({length:code.split('\n').length},(_,i)=>i+1).join('\n');}
function syncCodeGutter(editor){
  if(!editor)return;
  const gutter=document.getElementById('code-line-numbers');
  if(gutter){gutter.textContent=codeLineNumbers(editor.value);gutter.scrollTop=editor.scrollTop||0;}
  const currentLine=editor.value.slice(0,editor.selectionStart||0).split('\n').length;
  editor.style?.setProperty?.('--editor-current-line',String(currentLine));
  editor.style?.setProperty?.('--editor-scroll-top',`${editor.scrollTop||0}px`);
}
function codeEditor(){return `<div class="lg-code-editor"><div class="lg-code-toolbar"><label for="code-language">语言 <select class="input" id="code-language">${CODE_LANGUAGES.map(([id,name])=>`<option value="${id}" ${state.codeLanguage===id?'selected':''}>${name}</option>`).join('')}</select></label><button class="btn secondary small" data-do="copy-code">${uiIcon('copy')}复制代码</button></div><div class="lg-editor-surface lg-editor-frame"><pre id="code-line-numbers" class="lg-code-gutter lg-line-numbers" aria-hidden="true">${codeLineNumbers(state.codeDraft)}</pre><textarea id="code-editor" class="input" aria-label="代码编辑器" rows="20" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off" placeholder="在此输入代码…">${escape(state.codeDraft)}</textarea></div><div class="lg-editor-status"><span>代码已保存在此浏览器</span><span id="code-count">${state.codeDraft.length} 字符</span></div><div class="controls"><button type="button" class="btn primary" data-do="code-submit">提交评测</button></div></div>`;}

function nightActions(room){
  const g=room?.game;
  if(!room)return `<div class="action-panel"><p>加入房间后，可在这里进行夜间行动。</p><button class="btn primary" data-do="join-modal">输入房号加入</button></div>`;
  const night=NIGHT_PHASES.includes(g?.phase),finished=g?.phase==='finished';
  return `<div class="lg-night-actions"><div class="lg-game-toolbar"><strong>房间 #${escape(room.code)} · ${g?escape(g.phaseLabel):'等待开始'}</strong>${g?.deadline?`<strong class="timer" data-deadline="${g.deadline}"></strong>`:''}</div>${g?.myRole&&!state.replay?`<div class="identity">你的身份：${badge(g.myRole)}</div>${privateInfo(g)}`:''}${night&&!state.replay?actionPanel(g):`<div class="action-panel"><p>${finished?'对局已结束，夜间行动记录与队内发言已公开。':g?'当前为白天阶段，请返回题目背景操作。':'游戏开始后，夜间行动会显示在这里。'}</p></div>`}${g&&(isWolfRole(g.myRole)&&night||finished)?chatPanel(room,'wolf'):''}<div class="controls"><button class="btn secondary" data-problem-tab="description">返回题目背景</button>${night&&state.demo&&!state.replay?'<button class="btn secondary small" data-do="demo-next">跳到本阶段结算</button>':''}</div></div>`;
}
function captureCodeEditor(){
  const editor=document.getElementById('code-editor');if(!editor)return;
  state.codeDraft=editor.value;storage.set('codeDraft',state.codeDraft);
  state.codeSelection={start:editor.selectionStart??0,end:editor.selectionEnd??0,top:editor.scrollTop||0,left:editor.scrollLeft||0};
}
async function copyCode(){
  captureCodeEditor();
  try{await navigator.clipboard.writeText(state.codeDraft);toast('代码已复制');}
  catch{const editor=document.getElementById('code-editor');if(!editor)return;editor.focus();editor.select();let copied=false;try{copied=Boolean(document.execCommand?.('copy'));}catch{}if(copied){editor.setSelectionRange(state.codeSelection.start,state.codeSelection.end);toast('代码已复制');}else toast('代码已选中，请按 Ctrl+C 或 ⌘C 复制');}
}

function privateInfo(g){const info=g.privateInfo||{};return `<div class="private-info">${info.results?.length?`<div class="alert info">查验结果：${info.results.map(r=>`${r.seat} 号 ${escape(r.name)} · ${r.team==='wolf'?'狼人':'好人'}`).join('；')}</div>`:''}${info.wolfTeammates?.length?`<p class="small muted">狼人同伴：${info.wolfTeammates.map(p=>`${p.seat} 号 ${escape(p.name)}`).join('、')}</p>`:''}${info.wolfVotes?.length?`<p class="small muted">队内选择：${info.wolfVotes.map(v=>`${g.players.find(p=>p.id===v.playerId)?.seat} 号 → ${v.targetId?(g.players.find(p=>p.id===v.targetId)?.seat+' 号'):'空刀'}`).join('；')}</p>`:''}${info.potions?`<p class="small muted">解药：${info.potions.save?'可用':'已用'} · 毒药：${info.potions.poison?'可用':'已用'}${g.phase==='witch'&&info.nightVictim?` · 今夜被袭击：${info.nightVictim.seat} 号 ${escape(info.nightVictim.name)}`:''}</p>`:''}</div>`;}
function sheriffPanel(g){
  if(!g.config.sheriff)return '';
  const holder=g.players.find(p=>p.id===g.sheriffId),candidates=g.sheriffCandidates||[];
  const election=['sheriff_signup','sheriff_speech','sheriff_vote'].includes(g.phase),transfer=g.phase==='sheriff_transfer',pending=!g.sheriffElectionDone&&g.round===1&&['guard','wolf','seer','witch'].includes(g.phase);
  const title=transfer?'警徽移交中':holder?`警长：${holder.seat} 号 ${escape(holder.name)}`:election?'警长竞选'+(g.sheriffRunoff?' · 平票加赛':''):pending?'已开启上警':'当前无警长';
  const help=transfer?'原警长可将警徽交给一名有投票权的存活玩家，或选择撕毁；超时视为撕毁。':election?'竞选结束后公布首夜死讯。上警玩家发言，未报名的警下玩家投票；超时未操作视为放弃。':holder?'警长选择发言方向，放逐票计 1.5 票，常规白天最后发言。':pending?'首夜行动结束后开始竞选，竞选后公布首夜死讯。':'警徽流失后不再重新竞选。';
  return `<div class="sheriff-panel"><strong>${title}</strong><p class="small">${help}${candidates.length&&election?`<br>候选人：${candidates.map(p=>`${p.seat} 号 ${escape(p.name)}`).join('、')}`:''}</p></div>`;
}
function actionPanel(g){
  const speech=['discussion','lastwords','sheriff_speech'].includes(g.phase);
  if(!g.actionable)return `<div class="action-panel"><p>${g.submitted?(['guard','wolf','seer','witch'].includes(g.phase)?'已提交，等待本阶段倒计时结束。':'已提交，等待其他玩家完成行动。'):speech?'请等待轮到你发言。可以先在右侧输入草稿。':g.phase==='sheriff_vote'?'等待警下玩家投票。报名上警者即使退水也不能投票。':g.phase==='sheriff_transfer'?'等待原警长移交或撕毁警徽。':g.phase==='sheriff_direction'?'等待警长选择发言方向。':'等待本阶段结束，请留意倒计时。'}</p></div>`;
  if(speech)return `<div class="action-panel"><strong>轮到你${g.phase==='lastwords'?'发表遗言':g.phase==='sheriff_speech'?'竞选发言':'发言'}了</strong><p>在右侧「相关讨论」中输入内容，发言完成后点击该区域的「结束发言」。</p></div>`;
  if(g.phase==='sheriff_signup')return `<div class="action-panel"><strong>是否上警竞选警长？</strong><p>上警后将依次发表竞选发言。不上警可为候选人投票；报名超时视为不上警。</p><div class="controls"><button class="btn primary" data-action="join">我要上警</button><button class="btn secondary" data-action="skip">不上警</button></div></div>`;
  if(g.phase==='sheriff_direction')return `<div class="action-panel"><strong>选择本轮发言方向</strong><p>从警长相邻座位开始依次发言，最后由警长发言。左侧按座位号递减，右侧按座位号递增；超时默认从右侧开始。</p><div class="controls"><button class="btn primary" data-action="left">从左侧开始</button><button class="btn primary" data-action="right">从右侧开始</button></div></div>`;
  const targets=g.action?.targets||[],voting=['vote','sheriff_vote'].includes(g.phase),transfer=g.phase==='sheriff_transfer';
  return `<div class="action-panel"><strong>${escape(g.phaseLabel)} · ${transfer?'移交或撕毁警徽':'选择目标'}</strong>${transfer?'<p>选择一位存活玩家接任警长，或撕毁警徽。撕毁或超时后，本局不再有警长。</p>':''}${voting?`<p>${availableTarget(g,state.target)?`已选择 ${targets.find(p=>p.id===state.target)?.seat} 号 ${escape(targets.find(p=>p.id===state.target)?.name)}，点击「确认投票」提交。`:'请点击题目背景中的玩家头像选择投票目标，也可以弃权。'}</p>`:`<div class="targets">${targets.map(p=>`<button class="target ${state.target===p.id?'selected':''}" data-target="${escape(p.id)}">${p.seat} 号 ${escape(p.name)}</button>`).join('')}</div>`}<div class="controls">${g.phase==='witch'?`${g.action?.choices?.includes('save')?'<button class="btn primary" data-action="save">使用解药</button>':''}${g.action?.choices?.includes('poison')?`<button class="btn danger" data-action="poison" ${!state.target?'disabled':''}>对所选玩家用毒</button>`:''}`:`<button class="btn primary" data-action="confirm" ${!availableTarget(g,state.target)?'disabled':''}>${transfer?'移交给所选玩家':voting?'确认投票':'确认选择'}</button>`}<button class="btn secondary" data-action="skip">${transfer?'撕毁警徽':voting?'弃权':'放弃行动'}</button></div></div>`;
}
function skillModal(type){
  const g=state.room?.game;
  if(!g||(type==='duel'?!g.canDuel:!g.canExplode))throw new Error('当前不能发动该技能');
  state.skill={type,targetId:type==='explode'&&g.myRole!=='whiteWolfKing'?null:undefined,key:state.actionKey,code:state.room.code};
  renderSkillModal();
}
function renderSkillModal(){
  const skill=state.skill,g=state.room?.game;if(!skill||!g)return;
  const duel=skill.type==='duel',white=g.myRole==='whiteWolfKing',targets=duel?g.duelTargets||[]:white?g.explodeTargets||[]:[];
  const title=duel?'确认骑士决斗':white?'白狼王自爆带人':'确认狼人自爆';
  const description=duel?'技能整局只能使用一次。目标是狼人：目标出局，直接进入黑夜。目标是好人：目标存活，你出局并继续白天。':white?'自爆会公开你的身份，你立即出局并结束白天。可以带走一名玩家，也可以只自爆。':'自爆会公开你的狼人身份，你将立即出局并结束当天发言与投票。狼王自爆不能再开枪。';
  modal(title,`<p>${description}</p>${targets.length?`<div class="targets">${targets.map(p=>`<button type="button" class="target ${skill.targetId===p.id?'selected':''}" data-skill-target="${escape(p.id)}">${p.seat} 号 ${escape(p.name)}</button>`).join('')}</div>`:''}${white&&!duel?`<button type="button" class="target ${skill.targetId===null?'selected':''}" data-skill-choice="none">仅自爆，不带人</button>`:''}<div class="controls"><button class="btn danger" data-do="confirm-skill" ${skill.targetId===undefined?'disabled':''}>${duel?'确认决斗':'确认自爆'}</button><button class="btn secondary" data-do="close-modal">取消</button></div>`);
}
async function confirmSkill(){
  const skill=state.skill,g=state.room?.game;
  if(!skill||!g||skill.code!==state.room.code||skill.key!==state.actionKey)throw new Error('阶段已变化，请重新选择技能');
  if(skill.type==='duel'?!g.canDuel:!g.canExplode)throw new Error('当前不能发动该技能');
  const targets=skill.type==='duel'?g.duelTargets||[]:g.explodeTargets||[];
  if(skill.targetId===undefined||(skill.targetId!==null&&!targets.some(p=>p.id===skill.targetId)))throw new Error('请重新选择有效目标');
  skill.submitting=true;try{await submitAction({type:skill.type,targetId:skill.targetId});closeModal();}catch(error){if(state.skill)state.skill.submitting=false;throw error;}
}
function chatPanel(room,channel){
  const g=room.game, isWolf=channel==='wolf', allowed=!state.replay&&(isWolf?Boolean(g?.canWolfChat):(!g||g.phase==='finished'||g.canSpeak));
  let entries=(room.messages||[]).filter(m=>(m.channel||'public')===channel).map(m=>({at:m.at||m.createdAt||0,html:`<div class="chat-message ${isWolf?'wolf-message':''}"><strong>${m.seat?m.seat+' 号 ':''}${escape(m.name||m.playerName||'玩家')}</strong> ${escape(m.text)}</div>`}));
  if(!isWolf)entries=entries.concat((g?.log||[]).map(l=>({at:l.at,html:`<div class="system-message">${escape(l.text)}</div>`}))).sort((a,b)=>a.at-b.at);
  return `<section class="card chat-card"><div class="card-header"><strong>${isWolf?'狼人队内频道':'相关讨论'}</strong><small class="muted">${isWolf?(g?.phase==='finished'?'对局已结束 · 记录公开':'仅狼人夜间可见'):(g?escape(g.phaseLabel):'房间交流')}</small></div><div class="chat-feed" id="feed-${channel}">${entries.length?entries.map(e=>e.html).join(''):'<p class="muted small">暂无发言记录。</p>'}</div>${!state.replay?`<form class="chat-form" data-chat="${channel}"><textarea class="input chat-input" id="draft-${channel}" aria-label="${isWolf?'狼人队内消息':'发言内容'}" maxlength="500" rows="3" placeholder="${allowed?'输入你的发言…':'可以先写草稿，轮到你时再发送…'}">${escape(isWolf?state.wolfDraft:state.draft)}</textarea><div class="chat-actions"><small class="muted">${allowed?'可以发言':'当前不能发送'} · 最多 500 字</small><button class="btn primary small" type="submit" ${allowed?'':'disabled'}>发送</button></div>${!isWolf&&g?.canSpeak&&g?.actionable?'<button type="button" class="btn secondary small lg-end-speech" data-do="pass">结束发言</button>':''}</form>`:''}</section>`;
}
function render(){
  captureCodeEditor();
  const focused=document.activeElement,focus=focused?.id,value=focus?focused.value:null,caret=focus?focused.selectionStart:null,selectionEnd=focus?focused.selectionEnd:null;
  const scrolls={};document.querySelectorAll('.chat-feed').forEach(x=>scrolls[x.id]={top:x.scrollTop,bottom:x.scrollHeight-x.scrollTop-x.clientHeight<40});
  const body=state.page==='room'?roomView():state.page==='rules'?`<div class="section-heading"><h1>游戏规则</h1><button class="link-button" data-page="room">返回题目</button></div><section class="card"><div class="card-body">${rules()}</div></section>`:state.page==='history'?`<div class="section-heading"><h1>对局历史</h1><div><button class="link-button" data-page="room">返回题目</button> · <button class="link-button" data-do="refresh">刷新</button></div></div><section class="card">${historyTable([...state.demoHistory,...state.history])}</section>`:lobby();
  $('#app').innerHTML=shell(body);updateClock();
  if(focus){const el=document.getElementById(focus);if(el){el.value=value;el.focus({preventScroll:true});if(caret!==null&&el.setSelectionRange)try{el.setSelectionRange(caret,selectionEnd??caret);}catch{}}}
  const editor=document.getElementById('code-editor');if(editor){const position=state.codeSelection;editor.setSelectionRange(position.start,position.end);editor.scrollTop=position.top;editor.scrollLeft=position.left;syncCodeGutter(editor);}
  document.querySelectorAll('.chat-feed').forEach(x=>{const old=scrolls[x.id];x.scrollTop=!old||old.bottom?x.scrollHeight:old.top;});
}

function updateClock(){document.querySelectorAll('[data-deadline]').forEach(x=>{const sec=Math.max(0,Math.ceil((+x.dataset.deadline-Date.now())/1000));x.textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;x.classList.toggle('urgent',sec<=15);});}

function healthLink() {
  try {
    const url = new URL((state.apiBase || new URL(location.href).origin) + '/api/health');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}
function connectionBanner() {
  if (state.checking) return '<div class="lg-connection">正在连接游戏服务…</div>';
  if (state.online || state.demo) return '';
  const link = healthLink();
  return `<div class="lg-connection alert warning" role="status"><strong>联机未连接</strong> · ${escape(state.connectError || '正在恢复连接')} <button class="link-button" data-do="reconnect">立即重连</button> · <button class="link-button" data-do="settings">联机设置</button>${link ? ` · <a href="${escape(link)}" target="_blank" rel="noopener noreferrer">检查服务器</a>` : ''}</div>`;
}
function failureDetail(error, path) {
  const stage = ({'/api/health':'检查服务器','/api/session':'建立玩家会话','/api/room':'同步房间'})[path] || '请求服务器';
  const prefix = error.status ? `HTTP ${error.status} · ` : '';
  return stage + '：' + prefix + error.message;
}
async function request(path, data, options = {}) {
  const method = data === undefined ? 'GET' : 'POST';
  const timeoutMs = ['/api/health', '/api/session'].includes(path) ? 30000 : 20000;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = controller && setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(state.apiBase + path, {
      method,
      headers: {
        ...(method === 'POST' ? {'Content-Type':'application/json'} : {}),
        ...(state.token && path !== '/api/health' ? {Authorization:'Bearer ' + state.token} : {}),
      },
      body: method === 'POST' ? JSON.stringify(data) : undefined,
      cache: 'no-store',
      signal: controller?.signal,
      ...options,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(body?.error || '服务器未能完成请求'), {status:response.status});
    if (!body || typeof body !== 'object') throw new Error('此地址没有返回游戏接口数据，请检查服务器地址');
    return body;
  } catch (error) {
    let cause = error;
    if (timedOut) cause = new Error(`等待服务器超过 ${timeoutMs / 1000} 秒`);
    else if (error instanceof TypeError || error.name === 'TypeError') {
      cause = new Error('浏览器未收到可读取的响应，请打开“检查服务器”测试当前网络');
    }
    cause.path = path;
    throw cause;
  } finally {
    if (controller) clearTimeout(timer);
  }
}
async function connect({quiet=false}={}){
  if(connectPromise)return connectPromise;
  connectPromise=(async()=>{
    if(!quiet)state.checking=true;
    state.online=false;networkRevision++;render();
    state.token=sessionStore.get('token:'+state.apiBase);
    try{
      const health=await request('/api/health');if(health.ok!==true||health.service!=='moonwolf')throw Object.assign(new Error('此地址未返回狼人杀联机服务'), {path:'/api/health'});
      let s;
      try{s=await request('/api/session',state.token?{}:{name:state.name});}
      catch(error){if(error.status!==401)throw error;state.token='';sessionStore.set('token:'+state.apiBase,'');s=await request('/api/session',{name:state.name});}
      state.token=s.token;state.player=s.player;state.name=s.player.name;storage.set('name',state.name);sessionStore.set('token:'+state.apiBase,s.token);state.online=true;state.pollFailures=0;state.connectError='';retryDelay=5000;
      // Reconcile the authoritative room after reconnect, even if its contents equal
      // the old JSON snapshot; local replay/demo state must not replace it.
      lastRoomJson='';await refreshData(true);
      if(state.pendingInvite&&!inviteShown&&!state.modal&&state.online){inviteShown=true;if(state.room?.code===state.pendingInvite){state.page='room';clearInvite();}else joinModal(state.pendingInvite);}
    }catch(e){state.online=false;state.connectError=failureDetail(e,e.path);nextReconnectAt=Date.now()+retryDelay;retryDelay=Math.min(retryDelay*2,30000);}
    finally{state.checking=false;render();}
  })();
  try{return await connectPromise;}finally{connectPromise=null;}
}
// Keep one polling stream: room requests also refresh the session heartbeat.
// Background tabs still check in well before the server's two-minute idle limit.
function pollDelay(){return document.visibilityState==='hidden'?(state.room?15000:45000):(state.room?3000:10000);}
async function refreshData(force=false){
  if(!state.online||state.demo||pollLock)return;pollLock=true;
  const revision=networkRevision;
  try{
    const r=await request('/api/room');if(revision!==networkRevision||state.demo)return;let changed=false;const json=JSON.stringify(r.room);
    if(json!==lastRoomJson){state.room=r.room;lastRoomJson=json;changed=true;}
    if(force && !state.replay && state.room && !state.pendingInvite && state.page==='lobby' && state.checking)state.page='room';
    const lobbyVisible=document.visibilityState!=='hidden'&&['lobby','history'].includes(state.page);
    if(lobbyVisible&&(force||Date.now()-lastLobbyRefreshAt>=30000)){
      lastLobbyRefreshAt=Date.now();
      const results=await Promise.allSettled([request('/api/rooms'),request('/api/history'),request('/api/stats')]);
      if(revision!==networkRevision||state.demo)return;
      if(results[0].status==='fulfilled')state.rooms=results[0].value.rooms||[];
      if(results[1].status==='fulfilled')state.history=results[1].value.history||results[1].value.games||[];
      if(results[2].status==='fulfilled')state.standings=results[2].value.standings||[];
      changed=true;
    }
    if(state.pollFailures){state.pollFailures=0;state.connectError='';changed=true;}
    if(changed)render();
  }catch(e){if(revision!==networkRevision)return;state.connectError=failureDetail(e,e.path);state.pollFailures++;if(e.status===401||state.pollFailures>=3){state.online=false;nextReconnectAt=Date.now()+1000;toast('连接中断，正在恢复会话');render();}}finally{pollLock=false;nextPollAt=Date.now()+pollDelay();}
}
function ensureOnline(){if(state.demo)throw new Error('请先退出本地试玩，再使用联机功能');if(!state.online)throw new Error('正在恢复联机连接，请稍后重试，或点击「立即重连」');}
async function mutation(path,data={}){ensureOnline();networkRevision++;try{const r=await request(path,data);networkRevision++;if('room'in r){state.room=r.room;lastRoomJson=JSON.stringify(r.room);}nextPollAt=Date.now()+pollDelay();render();return r;}catch(error){if(error.status===401){state.online=false;nextReconnectAt=Date.now()+1000;render();}throw error;}}
function settingsModal(){modal('联机设置',`<p class="muted">填写游戏服务器的完整地址。所有玩家使用同一服务器，即可共享匹配队列与房间。</p><form id="settings-form"><label class="field"><span>服务器地址</span><input id="api-base" class="input" type="url" value="${escape(state.apiBase)}" placeholder="https://your-server.example.com"><small class="muted">留空使用网站的默认服务器。</small></label><p class="form-error" id="settings-error"></p><button class="btn primary" type="submit">保存并连接</button></form>`);}
function profileModal(){modal('设置玩家昵称',`<form id="profile-form"><label class="field"><span>昵称（1–16 字）</span><input class="input" id="player-name" value="${escape(state.name)}" maxlength="16" required></label><p class="small muted">同一浏览器标签页会保留你的座位；游戏进行中不能修改昵称。</p><p class="form-error" id="profile-error"></p><button class="btn primary" type="submit">保存昵称</button></form>`);}
function joinModal(code=state.pendingInvite||''){modal(code?'加入好友房间':'输入房号加入',`<form id="join-form"><label class="field"><span>6 位随机房号</span><input class="input room-code-input" id="join-code" name="code" value="${escape(code)}" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="请输入 6 位数字" required></label><p class="small muted">你将以「${escape(state.name)}」加入。可在页面右上角修改昵称。</p><p class="form-error" id="join-error"></p><button class="btn primary full" type="submit">加入房间</button></form>`);}
function createModal(){state.config=copy(STANDARD_CONFIG);modal('自选配置开房',`<form id="create-form"><label class="field"><span>房间名称</span><input id="room-name" class="input" value="${escape(state.name)}的房间" maxlength="30" required></label><div class="config-total"><strong>角色配置 · 共 <span id="total-count">12</span> 人</strong><button type="button" class="link-button" data-do="reset-config">恢复标准局</button></div><div class="role-counters">${roleKeys.map(r=>`<div class="counter-item"><span title="${escape(ROLE_INFO[r].description)}">${badge(r)}</span><button type="button" data-count="${r}" data-delta="-1" aria-label="减少${ROLE_INFO[r].name}">−</button><output id="count-${r}">${state.config.roles[r]??0}</output><button type="button" data-count="${r}" data-delta="1" aria-label="增加${ROLE_INFO[r].name}">＋</button></div>`).join('')}</div><details class="role-help"><summary>查看角色技能</summary><dl>${roleKeys.map(r=>`<dt>${badge(r)}</dt><dd>${escape(ROLE_INFO[r].description)}</dd>`).join('')}</dl></details><label class="check-row sheriff-option"><input type="checkbox" id="sheriff-enabled"><span><strong>开启上警</strong><small>首日竞选警长，可选择发言方向并最后发言、放逐票计 1.5 票，可移交警徽。</small></span></label><div class="form-row"><label class="field"><span>房间类型</span><select id="visibility" class="input"><option value="private">私密房间 · 凭房号加入</option><option value="public">公开房间 · 展示在大厅</option></select></label><label class="field"><span>胜利条件</span><select id="victory" class="input"><option value="side">屠边（标准）</option><option value="all">屠城</option></select></label></div><div class="form-row"><label class="field"><span>夜间行动时限</span><select id="night-seconds" class="input"><option value="60">60 秒</option><option value="75" selected>75 秒</option><option value="90">90 秒</option></select></label><label class="field"><span>每人发言时限</span><select id="day-seconds" class="input"><option value="60">60 秒</option><option value="90" selected>90 秒</option><option value="120">120 秒</option></select></label></div><p class="small muted">6–18 人，狼王、白狼王及每种神职各最多 1 人；狼阵营总人数至少 1 人且少于半数。创建后自动生成不重复的 6 位房号。</p><p class="form-error" id="create-error"></p><button class="btn primary full" type="submit">创建房间</button></form>`);}
function updateCounts(){roleKeys.forEach(r=>{const el=$('#count-'+r);if(el)el.textContent=state.config.roles[r]??0;});if($('#total-count'))$('#total-count').textContent=size(state.config);}

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
      try{if(v.action?.type==='pass'){
        state.room.messages.push({name:p.name,seat:p.seat,at:Date.now(),channel:'public',text:v.phase==='lastwords'?'我的遗言结束。请继续推理。':'这是随机行动的试玩电脑。我发言结束。'});act(g,p.id,{type:'pass'},Date.now());break;
      }else{const target=v.action?.targets?.length?v.action.targets[Math.floor(Math.random()*v.action.targets.length)].id:null;act(g,p.id,{type:v.phase,targetId:v.phase==='witch'?null:target,choice:v.phase==='sheriff_direction'?'right':['witch','sheriff_signup'].includes(v.phase)?'skip':undefined},Date.now());}}
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
  if(event.target.id==='code-editor')syncCodeGutter(event.target);
  const b=event.target.closest('button,a[data-page]');if(!b)return;
  // This decorative evaluation button must never submit code or a game action.
  if(b.dataset.do==='code-submit'){event.preventDefault();return;}
  if(b.disabled)return;
  if(b.dataset.problemTab&&['description','submit'].includes(b.dataset.problemTab)){captureCodeEditor();state.problemTab=b.dataset.problemTab;render();return;}
  if(b.dataset.submitTab&&['code','file'].includes(b.dataset.submitTab)){captureCodeEditor();state.problemTab='submit';state.submitTab=b.dataset.submitTab;render();return;}
  if(b.dataset.do==='night-actions'){captureCodeEditor();state.problemTab='submit';state.submitTab='file';render();return;}
  if(b.dataset.do==='copy-code'){await copyCode();return;}
  if(b.dataset.page){event.preventDefault();await navigate(b.dataset.page);return;}
  if(b.dataset.count){const r=b.dataset.count;state.config.roles[r]=Math.max(0,Math.min(r==='wolf'?6:r==='villager'?12:1,(state.config.roles[r]??0)+Number(b.dataset.delta)));updateCounts();return;}
  if(state.busy)return;
  if(b.dataset.target){selectTarget(b.dataset.target);return;}
  if(b.dataset.skillTarget||b.dataset.skillChoice){if(state.skill){state.skill.targetId=b.dataset.skillTarget||null;renderSkillModal();}return;}
  state.busy=true;b.disabled=true;
  try{
    if(b.dataset.join)await joinRoom(b.dataset.join);
    else if(b.dataset.history){const local=state.demoHistory.find(g=>g.code===b.dataset.history);state.replay=local?local.room:(await request('/api/history/'+encodeURIComponent(b.dataset.history))).room;state.page='room';render();}
    else if(b.dataset.action){const a=b.dataset.action,g=state.room?.game;if(state.replay||!g?.actionable||g.submitted)throw new Error('当前不能进行此行动');if(['confirm','poison'].includes(a)&&!availableTarget(g,state.target))throw new Error('请选择有效目标');await submitAction({type:g.phase,targetId:['skip','save','join','left','right'].includes(a)?null:state.target,choice:['witch','sheriff_signup','sheriff_direction'].includes(g.phase)?(a==='skip'?'skip':a):undefined});}
    else switch(b.dataset.do){
      case'close-modal':closeModal();break;
      case'profile':profileModal();break;
      case'settings':settingsModal();break;
      case'reconnect':await connect();toast(state.online?'联机连接已恢复':'暂时无法连接，将继续自动重试');break;
      case'join-modal':joinModal();break;
      case'create':createModal();break;
      case'reset-config':state.config=copy(STANDARD_CONFIG);updateCounts();if($('#sheriff-enabled'))$('#sheriff-enabled').checked=false;if($('#victory'))$('#victory').value=STANDARD_CONFIG.victory;if($('#night-seconds'))$('#night-seconds').value=STANDARD_CONFIG.nightSeconds;if($('#day-seconds'))$('#day-seconds').value=STANDARD_CONFIG.daySeconds;break;
      case'refresh':await refreshData(true);toast('已刷新');break;
      case'match':await mutation('/api/match');state.page='room';state.replay=null;render();break;
      case'ready':await mutation('/api/ready',{ready:!state.room.players.find(p=>p.id===state.player.id)?.ready});break;
      case'start':await mutation('/api/start');break;
      case'leave':if(state.demo){state.demo=false;state.demoGame=null;state.room=null;state.page='lobby';await connect();}else{await mutation('/api/leave');state.page='lobby';render();await refreshData(true);}break;
      case'copy-room':try{await navigator.clipboard.writeText(state.room.code);toast('房号已复制：'+state.room.code);}catch{toast('房号：'+state.room.code);}break;
      case'copy-invite':{const link=invitationUrl(state.room.code);try{await navigator.clipboard.writeText(link);toast('邀请链接已复制，发给朋友即可加入');}catch{modal('邀请好友',`<p class="muted">将下面的链接发给朋友，或分享房号 ${escape(state.room.code)}。</p><label class="field"><span>邀请链接</span><input class="input" value="${escape(link)}" readonly aria-label="邀请链接"></label>`);}break;}
      case'pass':await submitAction({type:'pass'});break;
      case'withdraw':await submitAction({type:'withdraw'});break;
      case'duel':skillModal('duel');break;
      case'explode':skillModal('explode');break;
      case'confirm-skill':await confirmSkill();break;
      case'demo':startDemo();break;
      case'demo-next':state.demoGame.deadline=Date.now()-1;advance(state.demoGame,Date.now());syncDemo();break;
    }
  }catch(e){toast(e.message);}finally{state.busy=false;if(b.isConnected)b.disabled=false;}
});

function saveCodeLanguage(value){if(CODE_LANGUAGES.some(([id])=>id===value)){state.codeLanguage=value;storage.set('codeLanguage',value);}}
document.addEventListener('input',event=>{
  const field=event.target;
  if(field.id==='draft-public')state.draft=field.value;
  if(field.id==='draft-wolf')state.wolfDraft=field.value;
  if(field.id==='code-editor'){state.codeDraft=field.value;storage.set('codeDraft',field.value);state.codeSelection={start:field.selectionStart??0,end:field.selectionEnd??0,top:field.scrollTop||0,left:field.scrollLeft||0};const count=$('#code-count');if(count)count.textContent=`${field.value.length} 字符`;syncCodeGutter(field);}
  if(field.id==='code-language')saveCodeLanguage(field.value);
});
document.addEventListener('change',event=>{if(event.target.id==='code-language')saveCodeLanguage(event.target.value);});
document.addEventListener('scroll',event=>{if(event.target.id==='code-editor')syncCodeGutter(event.target);},true);
document.addEventListener('keyup',event=>{if(event.target.id==='code-editor')syncCodeGutter(event.target);});
document.addEventListener('selectionchange',()=>{if(document.activeElement?.id==='code-editor')syncCodeGutter(document.activeElement);});
document.addEventListener('submit',async event=>{
  event.preventDefault();const f=event.target;if(state.busy)return;state.busy=true;const submit=f.querySelector('[type="submit"]');if(submit)submit.disabled=true;
  try{
    if(f.id==='settings-form'){
      let url=$('#api-base').value.trim().replace(/\/$/,'') || defaultApi;if(url){const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('请填写不含路径、账户或参数的 HTTP(S) 地址');if(u.pathname!=='/')throw new Error('只需填写服务器域名，不需要 /api 路径');if(location.protocol==='https:'&&u.protocol!=='https:')throw new Error('当前网站使用 HTTPS，服务器也需要 HTTPS');}
      if(connectPromise)throw new Error('正在连接，请稍候再保存');
      if(state.room&&!state.demo&&url!==state.apiBase)throw new Error('请先离开当前房间，再更换服务器');const sameServer=url===state.apiBase;state.apiBase=url;storage.set('apiBase',url===defaultApi?'':url);state.demo=false;if(!sameServer){state.room=null;state.rooms=[];state.history=[];state.standings=[];state.page='lobby';}closeModal();await connect();toast(state.online?'连接成功':'连接失败，页面顶部显示了出错的步骤');
    }else if(f.id==='profile-form'){
      const name=$('#player-name').value.trim();if(!name||name.length>16)throw new Error('昵称需要 1–16 字');if(state.room?.game&&state.room.game.phase!=='finished')throw new Error('对局中不能修改昵称');if(state.online&&!state.demo){const s=await request('/api/session',{name});state.player=s.player;state.token=s.token;sessionStore.set('token:'+state.apiBase,s.token);}state.name=name;storage.set('name',name);closeModal();render();
    }else if(f.id==='create-form'){
      const config=validateConfig({...state.config,sheriff:$('#sheriff-enabled').checked,victory:$('#victory').value,nightSeconds:+$('#night-seconds').value,daySeconds:+$('#day-seconds').value});await mutation('/api/rooms',{name:$('#room-name').value.trim(),config,visibility:$('#visibility').value});closeModal();state.replay=null;state.page='room';render();
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
setInterval(()=>{
  updateClock();demoTick();
  if(state.demo||state.busy||pollLock)return;
  if(state.online){if(Date.now()>=nextPollAt)refreshData();}
  else if(!state.checking&&!connectPromise&&Date.now()>=nextReconnectAt)connect({quiet:true});
},500);
window.addEventListener('online',()=>{if(!state.demo&&!state.online)connect({quiet:true});});
document.addEventListener('visibilitychange',()=>{nextPollAt=Date.now()+pollDelay();if(document.visibilityState==='visible'&&!state.demo){if(state.online)refreshData();else connect({quiet:true});}});
render();connect();
