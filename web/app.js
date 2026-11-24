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
  sidebar:{tags:false, discussion:false, recommendations:false}, identityScope:null, adDismissed:false,
  page:'lobby', name:storage.get('name','玩家'+Math.floor(1000+Math.random()*9000)),
  apiBase:(storage.get('apiBase') || defaultApi).replace(/\/+$/,''),
  token:'', player:null, online:false, checking:true, room:null, memberships:[], rooms:[], history:[], standings:[],
  demo:false, demoGame:null, demoHistory:[], replay:null, target:null, actionKey:'', draft:'', wolfDraft:'',
  config:copy(STANDARD_CONFIG), modal:null, skill:null, busy:false, pollFailures:0,
  pendingInvite: /^\d{6}$/.test(new URL(location.href).searchParams.get('room')||'') ? new URL(location.href).searchParams.get('room') : null,
};
storage.set('name',state.name);
const badge = role => `<span class="badge ${isWolfRole(role)?'wolf':role==='villager'?'villager':'god'}">${escape(ROLE_INFO[role]?.name||role)}</span>`;
const roleTags = config => roleKeys.filter(r=>config.roles[r]).map(r=>`<span class="badge ${isWolfRole(r)?'wolf':r==='villager'?'villager':'god'}">${config.roles[r]} ${escape(ROLE_INFO[r].name)}</span>`).join(' ');
const resultLabel = winner => winner==='wolf'?'狼人胜利':winner==='good'?'好人胜利':'平局';
const formatTime = at => at ? new Date(at).toLocaleString('zh-CN',{hour12:false}) : '—';
let ballotQueue=Promise.resolve(), demoTimeOffset=0;
const demoNow=()=>Date.now()+demoTimeOffset;
let toastTimer, lastRoomJson='', pollLock=false, botTimer=0, nextPollAt=0, lastLobbyRefreshAt=0;
let connectPromise=null, nextReconnectAt=0, retryDelay=5000, networkRevision=0, inviteShown=false;

function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
function modal(title,body){state.modal=title;$('#modal-root').innerHTML=`<div class="overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${title}</h2><button class="close" data-do="close-modal" aria-label="关闭">×</button></div><div class="modal-body">${body}</div></section></div>`;setTimeout(()=>$('.modal input,.modal button,.modal select')?.focus(),0);}
function closeModal(){state.modal=null;state.skill=null;$('#modal-root').innerHTML='';}
function rules(){return `<ol class="rules-list">
  <li><strong>身份：</strong>默认 12 人标准局，${roleTags(STANDARD_CONFIG)}。开局随机分配身份；狼人知道同伴，其他玩家只知道自己。</li>
  <li><strong>天黑：</strong>守卫、预言家与狼队同时行动，女巫在狼队行动结束后用药。狼人可在队内频道讨论，选择袭击目标；预言家独自获知查验结果。已配置的夜间阶段保留固定时长，不因对应身份出局而跳过。未操作至超时视为放弃。</li>
  <li><strong>女巫与守卫：</strong>女巫一瓶解药、一瓶毒药，每夜最多一瓶，标准局仅首夜被刀可自救，开房可调整；守卫不能连续守同一人。同守同救仍会死亡。</li>
  <li><strong>天亮：</strong>公布死亡玩家，不公开身份。首夜死者可发表遗言；随后存活玩家依次发言，只有当前玩家可以发送，可点击「结束发言」。未轮到时可先写草稿。轮到时连续 60 秒未键入会被判定为挂机，此后每次发言只有 2 秒，点击「回到游戏」可恢复。</li>
  <li><strong>投票：</strong>具有投票权的存活玩家同时投票，点击头像即可投给该玩家，截止前可随时改票或弃权，不能投自己；警长放逐票计 1.5 票。投票结束后公布票型；平票玩家再发言并重新投票，再次平票则无人出局。</li>
  <li><strong>猎人：</strong>被袭击或放逐后可开枪带走一人；被女巫毒杀或白狼王带走不能开枪。<strong>狼人自爆：</strong>普通狼人和狼王可在白天发言、投票或警上发言时自爆，立即出局并结束当天。</li>
  <li><strong>狼王与白狼王：</strong>两者都参与夜间袭击和狼人队内交流。狼王出局可开枪，但被毒杀、自爆、骑士决斗或白狼王带走时不能开枪。白狼王仅在白天或警上发言阶段可自爆并带走一名玩家，也可选择只自爆；非自爆出局不能带人。白狼王及其带走的玩家没有遗言，被带走者不能发动死亡技能。</li>
  <li><strong>愚者：</strong>首次被投票放逐时翻牌免死，仍可发言，之后不能投票，也不能再被投票放逐；夜间袭击、毒药和技能仍可使其出局。翻牌时若持有警徽，警徽流失。</li>
  <li><strong>骑士：</strong>白天发言阶段可发动一次决斗。目标是狼人则目标出局并直接进入黑夜；目标是好人则目标存活、骑士出局，继续白天流程。</li>
  <li><strong>上警：</strong>建房时可勾选开启。首夜结束后先竞选警长，再公布死讯；首夜被袭击的玩家也能参加竞选。报名上警后依次发言，可在投票开始前退水；只有本轮未报名的警下玩家投票，退水玩家不能投票。平票加赛一次，再次平票或全员弃票则本局无警长。警长可选择白天发言方向，并在常规白天最后发言，放逐票计 1.5 票；出局时可移交警徽或撕毁，超时视为撕毁。警上发言期间狼人自爆会中止竞选并使警徽流失，结算首夜死讯后直接进入下一夜。</li>
  <li><strong>胜负：</strong>狼人全部出局则好人获胜。默认屠边：村民全部出局或神职全部出局，狼人获胜；自定义可选屠城，须淘汰所有好人。其余胜负条件均未达成时，全体存活玩家挂机判平局。超过 20 夜也判平局。</li>
  <li><strong>复盘：</strong>结束后公开所有身份，可查看发言、夜间行动和队内聊天。私密房间的记录仅参与者可查看。本版为文字游戏，房间配置与完整进度均由联机服务保存。</li>
</ol>`;}

function uiIcon(name){
  const paths={
    school:'<path d="m2 9 10-5 10 5-10 5zM5 11v6l7 4 7-4v-6M22 9v8"/>',
    training:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v4H9zM9 11h6M9 15h4"/>',
    contest:'<path d="M3 20v-2M7 20v-5M11 20v-8M15 20V9M19 20V5"/>',
    record:'<path d="M20.8 15a9 9 0 1 1-11-12v10zM13 2.6c4.5.5 7.8 3.6 8.3 8.4H13z"/>',
    forum:'<path d="M14.5 13c2.1-1.2 3.5-3 3.5-5 0-3.1-3.5-5.5-7.8-5.5S2.5 4.9 2.5 8c0 1.7 1 3.2 2.8 4.3L4 15.5l4.5-2.1c.7.1 1.3.2 2 .2"/><path d="M16.6 10.5c3.1.8 5.1 2.7 5.1 5 0 1.4-.8 2.8-2.4 3.8l.8 2.3-3.8-1.3c-3.8 0-6.8-2.1-6.8-4.8 0-1 .4-2 1.3-2.8"/>',
    article:'<rect x="5" y="3" width="16" height="17" rx="2"/><path d="M2 7v12c0 1.1.9 2 2 2M8 7h4v4H8zM15 7h3M15 10h3M8 14h10M8 17h8"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.7"/><path d="m16 16 5 5"/>',
    adjust:'<path d="M3 6h6m4 0h8M3 12h12m4 0h2M3 18h3m4 0h11"/><circle cx="11" cy="6" r="2"/><circle cx="17" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
    home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',problem:'<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',history:'<path d="M4 5h16v16H4zM8 2v6M16 2v6M4 10h16M8 14h3M8 17h7"/>',rules:'<path d="M12 6c-3-3-7-2-9-1v15c3-2 6-2 9 0 3-2 6-2 9 0V5c-2-1-6-2-9 1zM12 6v14"/>',settings:'<path d="m10 2-.6 2.5-2.1 1.2L4.8 5l-2 3.5 1.9 1.8v2.4l-1.9 1.8 2 3.5 2.5-.7 2.1 1.2.6 2.5h4l.6-2.5 2.1-1.2 2.5.7 2-3.5-1.9-1.8v-2.4l1.9-1.8-2-3.5-2.5.7-2.1-1.2L14 2z"/><circle cx="12" cy="11.5" r="3"/>',submit:'<path d="M5 3h10l4 4v7M14 3v5h5M5 3v18h7M17 14v8M13 18l4-4 4 4"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H4v13h4"/>'};
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name]||paths.problem}</svg>`;
}
const ORIGINAL_PROBLEM_URL = 'https://www.luogu.com.cn/problem/P4899';

const railItems = [
  {label: '首页', icon: 'home', page: 'lobby'},
  {label: '题库与我的房间', icon: 'problem', page: 'room'},
  {label: '网校', icon: 'school', href: 'https://class.luogu.com.cn/'},
  {label: '训练题单', icon: 'training', href: 'https://www.luogu.com.cn/training/list'},
  {label: '比赛', icon: 'contest', href: 'https://www.luogu.com.cn/contest/list'},
  {label: '对局记录', icon: 'record', page: 'history'},
  {label: '讨论区', icon: 'forum', href: 'https://www.luogu.com.cn/discuss', divider: true},
  {label: '文章广场', icon: 'article', href: 'https://www.luogu.com.cn/article'},
];

function railControl(item) {
  const contents = `<span class="lg-rail-icon">${uiIcon(item.icon)}</span><small>${item.label}</small>`;
  if (item.href) {
    const label = '前往洛谷' + item.label;
    return `${item.divider ? '<hr class="lg-rail-divider">' : ''}<a href="${item.href}" target="_blank" rel="noopener noreferrer" aria-label="${label}" title="${label}">${contents}</a>`;
  }
  return `<button data-page="${item.page}" class="${state.page === item.page ? 'active' : ''}" aria-label="${item.label}" title="${item.label}">${contents}</button>`;
}

function shell(content) {
  return `<aside class="lg-rail" aria-label="主导航">${railItems.map(railControl).join('')}</aside>
    <header class="lg-topbar">
      <button class="lg-topbar-brand" data-page="lobby" aria-label="题目首页"><img src="./assets/luogu.ico" alt="洛谷" width="36" height="36"></button>
      <div class="lg-breadcrumb"><button class="link-button" data-page="lobby">题目列表</button><span aria-hidden="true">/</span><span>P4899</span></div>
      <div class="lg-topbar-tools">
        <a href="https://www.luogu.com.cn/problem/list" target="_blank" rel="noopener noreferrer" aria-label="在洛谷搜索题目" title="在洛谷搜索题目">${uiIcon('search')}</a>
        <button data-page="rules" aria-label="游戏规则" title="游戏规则">${uiIcon('rules')}</button>
        <button data-do="settings" aria-label="联机设置" title="联机设置">${uiIcon('adjust')}</button>
        <button class="account" data-do="profile" aria-label="玩家昵称：${escape(state.name)}" title="${escape(state.name)}"><span class="lg-profile-avatar">${escape(state.name.slice(0,1))}</span></button>
      </div>
    </header>
    <div class="lg-page">${connectionBanner()}${content}<footer class="footer">P4899 · [IOI 2018] werewolf 狼人 <button class="link-button" data-page="rules">规则说明</button></footer></div>`;
}

function historyTable(list,empty='暂无已结束的对局'){return `<div class="table-wrap"><table class="table"><thead><tr><th>对局</th><th>结果</th><th>天数</th><th>结束时间</th></tr></thead><tbody>${list.length?list.map(g=>`<tr><td><button class="link-button history-link" data-history="${escape(g.code)}">#${escape(g.code)}</button>${g.demo?' <small class="muted">试玩</small>':''}</td><td><span class="badge ${g.winner==='wolf'?'wolf':g.winner==='good'?'good':'villager'}">${resultLabel(g.winner)}</span></td><td>${escape(g.round)}</td><td>${formatTime(g.endedAt)}</td></tr>`).join(''):`<tr><td colspan="4" class="empty-row">${empty}</td></tr>`}</tbody></table></div>`;}
const NIGHT_PHASES=['night','guard','wolf','seer','witch'];
const isVoting = g => ['vote','sheriff_vote'].includes(g?.phase);
const selfSaveLabels = {none:'不能自救',first:'仅第一晚被刀可以自救',always:'可以自救'};
const CODE_LANGUAGES=[['cpp14','C++14'],['cpp17','C++17'],['cpp20','C++20'],['c','C'],['python3','Python 3'],['java17','Java 17'],['rust','Rust'],['javascript','JavaScript']];
function syncActionKey(room){
  const g=room?.game,key=g?`${g.round}:${g.phase}:${g.action?.type||''}:${g.currentSpeakerId||''}:${g.deadline}`:'';
  if(state.actionKey!==key){state.actionKey=key;state.target=null;if(state.skill){const submitted=state.skill.submitting;closeModal();if(!submitted)toast('阶段已变化，请重新选择技能目标');}}
}
function problemPage(room){
  syncActionKey(room);
  const scope = JSON.stringify([state.apiBase, state.player?.id, state.replay ? 'replay' : 'live', room?.code, room?.game?.myRole]);
  if (scope !== state.identityScope) {
    state.sidebar.tags = false;
    state.identityScope = scope;
  }
  return `<header class="lg-problem-header"><h1>${escape(PROBLEM_TITLE)}</h1><div class="lg-problem-stats"><span class="lg-stat"><span>提交</span><strong>5.29k</strong></span><span class="lg-stat"><span>通过</span><strong>2.59k</strong></span><span class="lg-stat"><span>时间限制</span><strong>4.00s</strong></span><span class="lg-stat"><span>内存限制</span><strong>537.00MB</strong></span></div></header>
  ${room&&!state.replay&&room.game?.myAfk&&room.game.phase!=='finished'?'<div class="alert warning">你已被判定为挂机。 <button class="btn primary small" data-do="return">回到游戏</button></div>':''}
  <nav class="lg-problem-tabs" aria-label="题目页签"><button class="${state.problemTab==='description'?'active':''}" data-problem-tab="description" aria-pressed="${state.problemTab==='description'}">题目描述</button><button class="${state.problemTab==='submit'?'active':''}" data-problem-tab="submit" aria-pressed="${state.problemTab==='submit'}">提交答案</button><span class="lg-header-tools"><button type="button" data-do="copy-problem">复制题目链接</button><a href="${ORIGINAL_PROBLEM_URL}" target="_blank" rel="noopener noreferrer" title="前往洛谷 P4899 原题">查看原题</a></span></nav>
  <div class="lg-layout"><main class="lg-main">${state.problemTab==='submit'?submissionView(room):`<section class="lg-card lg-background"><h2>题目背景</h2><p class="lg-background-intro">本题为交互题，但在此请提交<strong>完整程序</strong>。</p>${room?roomBackground(room):lobbyBackground()}</section><article class="lg-card lg-statement lg-statement-connected">${PROBLEM_CONTENT_HTML}</article>`}</main><aside class="lg-sidebar">${problemMeta()}${tagsPanel(room)}${discussionPanel(room)}${recommendationsPanel()}${sidebarAd()}</aside></div>`;
}

function problemMeta() {
  return `<section class="lg-card lg-problem-meta">
    <div class="lg-meta-row"><span>题目编号</span><strong>P4899</strong></div>
    <div class="lg-meta-row"><span>提供者</span><a class="lg-provider" href="https://www.luogu.com.cn/user/50167" target="_blank" rel="noopener noreferrer">Imagine</a></div>
    <div class="lg-meta-row"><span>难度</span><strong class="lg-difficulty">省选/NOI−</strong></div>
    <div class="lg-meta-row"><span>历史分数</span><span>暂无</span></div>
    <div class="lg-reference-links">
      <button class="link-button" data-page="history">${uiIcon('history')}<span>提交记录</span></button>
      <a href="https://www.luogu.com.cn/problem/solution/P4899" target="_blank" rel="noopener noreferrer">${uiIcon('rules')}<span>查看题解</span></a>
      <a href="https://www.luogu.com.cn/ticket?type=problem.general&amp;related=P4899" target="_blank" rel="noopener noreferrer">${uiIcon('problem')}<span>题目反馈</span></a>
    </div></section>`;
}

function sideSection(key, cssClass, title, show, hide, body, preview = '') {
  const open = state.sidebar[key];
  const controls = `data-sidebar-toggle="${key}" aria-expanded="${open}" aria-controls="sidebar-${key}"`;
  return `<section class="lg-card lg-side-section ${cssClass}">
    <div class="lg-side-heading"><h3><button type="button" class="lg-side-title" id="heading-${key}" ${controls}>${title}</button></h3></div>
    ${preview}
    <div class="lg-side-content" id="sidebar-${key}"${open ? '' : ' hidden'}>${open ? body() : ''}</div>
    <button type="button" class="lg-disclosure" id="toggle-${key}" ${controls}><span class="lg-disclosure-arrow" aria-hidden="true"></span>${open ? hide : show}</button>
  </section>`;
}

function identityPanel(room) {
  const game = room?.game;
  if (!game) return '<p class="muted small">游戏开始后可在此查看自己的身份。</p>';
  if (state.replay || game.phase === 'finished') {
    const roles = game.players.filter(p => p.role).map(p => `<li>${p.seat} 号 ${escape(p.name)} · ${badge(p.role)}</li>`).join('');
    return `<ul class="lg-role-roster">${roles}</ul>`;
  }
  if (room.isSpectator || !game.myRole) return '';
  const skills = [
    game.canDuel ? '<button class="btn danger small" data-do="duel">骑士决斗</button>' : '',
    game.canExplode ? `<button class="btn danger small" data-do="explode">${game.myRole === 'whiteWolfKing' ? '白狼王自爆带人' : '狼人自爆'}</button>` : '',
  ].join('');
  return `<div class="lg-personal-role"><strong>你的身份：</strong>${badge(game.myRole)}
    <p class="small">${escape(ROLE_INFO[game.myRole]?.description)}</p>${privateInfo(game)}
    ${skills ? `<div class="controls">${skills}</div>` : ''}</div>`;
}

const problemAlgorithms = [[53, '树状数组'], [68, 'Kruskal 重构树'], [127, '深度优先搜索 DFS'], [233, '可持久化线段树'], [379, '线段树合并']];
function tagsPanel(room) {
  const chips = '<div class="lg-tags"><span class="lg-tag-source">IOI</span><span class="lg-tag-year">2018</span><span class="lg-tag-feature">O2优化</span></div>';
  const contents = () => {
    const algorithms = problemAlgorithms.map(([id, name]) =>
      `<a href="https://www.luogu.com.cn/problem/list?tag=${id}" target="_blank" rel="noopener noreferrer">${name}</a>`).join('');
    return `<div class="lg-tags lg-algorithm-tags">${algorithms}</div>${room ? identityPanel(room) : ''}`;
  };
  return sideSection('tags', 'lg-problem-tags', '标签', '显示算法标签', '隐藏算法标签', contents, chips);
}

function discussionPanel(room) {
  return sideSection('discussion', 'lg-discussion', '相关讨论', '查看讨论', '收起讨论', () => room
    ? chatPanel(room, 'public')
    : '<p class="muted small">加入房间后可在此发言。</p><button class="btn primary small" data-do="join-modal">输入房号加入</button>');
}

const recommendedProblems = [
  ['P3684', '[CERC2016] 机棚障碍 Hangar Hurdles'],
  ['P3302', '[SDOI2013] 森林'],
  ['P4768', '[NOI2018] 归程'],
  ['P4898', '[IOI 2018] seats 排座位'],
  ['P5055', '【模板】可持久化文艺平衡树'],
];
function recommendationsPanel() {
  return sideSection('recommendations', 'lg-recommendations', '推荐题目', '查看推荐', '收起推荐', () =>
    `<ul class="lg-rec-list">${recommendedProblems.map(([id, title]) =>
      `<li><a href="https://www.luogu.com.cn/problem/${id}" target="_blank" rel="noopener noreferrer">${id} ${title}</a></li>`).join('')}</ul>`);
}

function sidebarAd() {
  if (state.adDismissed) return '';
  return `<div class="lg-side-ad"><a href="https://help.luogu.com.cn/manual/luogu/commercial-contest" target="_blank" rel="noopener noreferrer"><img src="./assets/luogu-recommended.png" width="400" height="200" alt="洛谷推荐：商业比赛"></a><div class="lg-ad-caption"><span>洛谷推荐</span><button type="button" data-do="dismiss-ad" aria-label="关闭广告">×</button></div></div>`;
}

function membershipMenu(){
  if(state.replay||state.demo||!state.memberships.length||(state.memberships.length===1&&state.memberships[0].code===state.room?.code))return '';
  return `<label>切换房间 <select class="input" id="switch-room">${!state.room?'<option value="" selected disabled>选择房间</option>':''}${state.memberships.map(r=>`<option value="${escape(r.code)}" ${r.code===state.room?.code?'selected':''}>${escape(r.name)} #${escape(r.code)}</option>`).join('')}</select></label>`;
}
function lobby(){return problemPage(null);}
function lobbyBackground(){return `<div class="seats">${Array.from({length:12},(_,i)=>`<div class="seat empty"><span class="seat-number">${i+1}</span><div class="avatar">＋</div><div class="seat-name muted">等待加入</div></div>`).join('')}</div><div class="lg-game-toolbar">${membershipMenu()}<span class="small muted">默认 12 人标准局 · 6 位随机房号</span><button class="link-button" data-page="rules">玩法说明</button></div><div class="controls">${state.room?'<button class="btn primary" data-page="room">回到我的房间</button>':''}${!state.room||state.room.isSpectator?'<button class="btn primary" data-do="match">开始匹配</button>':''}<button class="btn secondary" data-do="create">自选配置开房</button><button class="btn secondary" data-do="join-modal">输入房号加入</button><button class="btn secondary" data-do="demo">本地试玩</button></div><p class="small muted">匹配满 12 人自动开局，自建房由房主在全员准备后开始。</p><details class="lg-public-rooms"><summary>公开房间 · ${state.rooms.length} 个</summary><div class="lg-game-toolbar"><button class="link-button" data-do="refresh">刷新房间</button></div><div class="table-wrap"><table class="table"><thead><tr><th>房号</th><th>房间名</th><th>人数</th><th></th></tr></thead><tbody>${state.rooms.length?state.rooms.map(r=>`<tr><td>${escape(r.code)}</td><td>${escape(r.name)}</td><td>${r.playerCount} / ${r.capacity}</td><td><button class="btn primary small" data-join="${escape(r.code)}">加入</button></td></tr>`).join(''):'<tr><td colspan="4" class="empty-row">暂无等待中的公开房间</td></tr>'}</tbody></table></div></details><details class="lg-public-rooms"><summary>胜场榜</summary><div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>玩家</th><th>胜 / 局</th><th>胜率</th></tr></thead><tbody>${state.standings.length?state.standings.slice(0,20).map((p,i)=>`<tr><td>${i+1}</td><td>${escape(p.name)}</td><td>${p.wins} / ${p.games}</td><td>${(p.games?p.wins/p.games*100:0).toFixed(1)}%</td></tr>`).join(''):'<tr><td colspan="4" class="empty-row">完成第一局后生成战绩</td></tr>'}</tbody></table></div></details>`;}
function roomView(){return problemPage(state.replay||state.room);}
function availableTarget(g,id){
  if(state.replay||!g?.actionable||(g.submitted&&!isVoting(g))||!g.action?.targets?.some(p=>p.id===id))return false;
  if(isVoting(g)){
    const p=g.players.find(p=>p.id===id);
    return Boolean(p&&p.id!==state.player?.id&&p.alive!==false&&!p.foolRevealed);
  }
  return true;
}
function selectTarget(id){const g=state.room?.game;if(!availableTarget(g,id))return false;syncActionKey(state.room);state.target=id;render();return true;}
function roomBackground(room){
  const game=room.game,myId=state.player?.id,me=room.players.find(p=>p.id===myId),host=room.hostId===myId;
  const players=game?.players||room.players,capacity=size(room.config),current=game?.players.find(p=>p.id===game.currentSpeakerId),voting=isVoting(game);
  return `<div class="lg-game-toolbar"><strong>${state.replay?'对局回放':'房间'} #${escape(room.code)}</strong>${membershipMenu()}<div><button class="link-button" data-page="lobby">大厅</button> · <button class="link-button" data-page="history">对局历史</button></div></div>${state.demo&&!state.replay?'<div class="alert warning">本地试玩 · 其余座位为随机行动的电脑玩家。</div>':''}
  <div class="room-status"><div><strong class="status-title">${game?game.phase==='finished'?resultLabel(game.winner):`第 ${game.round} ${NIGHT_PHASES.includes(game.phase)?'夜':'天'} · ${escape(game.phaseLabel)}`:room.matchmaking?'匹配中，等待玩家加入':'等待玩家准备'}</strong><p class="status-detail">${game?game.phase==='finished'?'游戏结束，所有身份与记录已公开。':current?`当前由 ${current.seat} 号 ${escape(current.name)} ${game.phase==='lastwords'?'发表遗言':'发言'}。`:voting?(game.actionable?'点击头像投票，截止前可以改投或弃权。':'等待本轮投票截止。'):NIGHT_PHASES.includes(game.phase)?'夜间行动请打开「提交答案 → 提交文件」。':'可展开「标签」查看身份和技能。':`${escape(room.name)} · ${room.players.length} / ${capacity} 人 · ${room.visibility==='private'?'私密房间':'公开房间'}`}</p></div>${game?.deadline?`<strong class="timer" data-deadline="${game.deadline}"></strong>`:!game?`<div class="controls"><button class="btn secondary small" data-do="copy-room">复制房号</button><button class="btn primary small" data-do="copy-invite">复制邀请链接</button></div>`:''}</div>
  <div class="seats">${Array.from({length:capacity},(_,i)=>{
    const p=players.find(x=>x.seat===i+1);if(!p)return `<div class="seat empty"><span class="seat-number">${i+1}</span>${!game&&!state.replay?`<button type="button" class="avatar lg-seat-button" data-seat="${i+1}" aria-label="${me?'换到':'加入'} ${i+1} 号座位">＋</button>`:'<div class="avatar">＋</div>'}<div class="seat-name muted">等待加入</div></div>`;
    const ready=room.players.find(x=>x.id===p.id)?.ready,selectable=voting&&availableTarget(game,p.id),selected=selectable&&game.submitted&&game.myVoteTargetId===p.id;
    return `<div class="seat ${p.id===myId?'me':''} ${p.alive===false?'dead':''} ${p.id===game?.currentSpeakerId?'speaking':''} ${selected?'selected':''}"><span class="seat-number">${p.seat}</span><button type="button" class="avatar lg-seat-button ${selected?'selected':''}" style="--avatar-hue:${(p.seat*47)%360}" ${selectable?`data-target="${escape(p.id)}"`:'disabled'} aria-label="${selectable?'选择投票目标：':''}${p.seat} 号 ${escape(p.name)}" aria-pressed="${selected}">${escape(p.name.slice(0,1))}</button><div class="seat-name">${escape(p.name)}${p.id===myId?'（你）':''}</div><div class="seat-status">${p.alive===false?'<span class="badge villager">出局</span>':game?p.id===game.currentSpeakerId?'<span class="badge good">正在发言</span>':'存活':ready?'<span class="badge good">已准备</span>':'未准备'}${p.id===game?.sheriffId?' <span class="badge sheriff">警长</span>':''}${p.foolRevealed?' <span class="badge villager">已翻牌 · 无投票权</span>':''}${p.id===room.hostId&&!game?' · 房主':''}</div></div>`;
  }).join('')}</div>${game?sheriffPanel(game):''}
  ${game?'':`<div class="config-tags">${roleTags(room.config)}</div><p class="small muted">${room.config.victory==='side'?'屠边':'屠城'} · 狼队 ${room.config.nightSeconds} 秒 · 其它行动 ${room.config.otherNightSeconds??30} 秒 · 女巫${selfSaveLabels[room.config.witchSelfSave??'first']}${room.config.shuffleSeats?' · 开局随机座位':''} · 每人发言 ${room.config.daySeconds} 秒 · ${room.config.sheriff?'开启上警':'不开启上警'}</p>`}
  ${!game?`<div class="controls">${room.isSpectator?'':room.matchmaking?'<span class="queue-count">满员后自动开始</span>':`<button class="btn ${me?.ready?'secondary':'primary'}" data-do="ready">${me?.ready?'取消准备':'准备'}</button>${host?`<button class="btn primary" data-do="start" ${room.players.length<capacity||room.players.some(p=>!p.ready)?'disabled':''}>开始游戏</button>`:''}`}${room.isSpectator?'':'<button class="btn secondary" data-do="observe">加入观战席</button>'}<button class="btn secondary" data-do="leave">${room.matchmaking&&!room.isSpectator?'取消匹配':'离开房间'}</button></div>`:state.replay?'<div class="controls"><button class="btn secondary" data-do="night-actions">查看夜间记录</button></div>':game.phase==='finished'?`<div class="controls"><button class="btn primary" data-do="leave">返回大厅</button><button class="btn secondary" data-do="night-actions">查看夜间记录</button></div>`:`${NIGHT_PHASES.includes(game.phase)?'<div class="action-panel"><button class="btn primary" data-do="night-actions">提交答案 → 提交文件</button><p class="small muted">展开「标签」可查看你的身份。</p></div>':actionPanel(game)}<div class="controls">${room.isSpectator?'<button class="btn secondary small" data-do="leave">离开房间</button>':''}${game.canWithdraw?'<button class="btn secondary small" data-do="withdraw">退出竞选（退水）</button>':''}${state.demo?'<button class="btn secondary small" data-do="demo-next">跳到本阶段结算</button><button class="btn secondary small" data-do="leave">退出试玩</button>':''}</div>`}`;
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
  return `<div class="lg-night-actions"><div class="lg-game-toolbar"><strong>房间 #${escape(room.code)} · ${g?escape(g.phaseLabel):'等待开始'}</strong>${g?.deadline?`<strong class="timer" data-deadline="${g.deadline}"></strong>`:''}</div>${night&&!state.replay?actionPanel(g):`<div class="action-panel"><p>${finished?'对局已结束，夜间行动记录与队内发言已公开。':g?'当前为白天阶段，请返回题目背景操作。':'游戏开始后，夜间行动会显示在这里。'}</p></div>`}${g&&!room.isSpectator&&(isWolfRole(g.myRole)&&night||finished)?chatPanel(room,'wolf'):''}<div class="controls"><button class="btn secondary" data-problem-tab="description">返回题目背景</button>${night&&state.demo&&!state.replay?'<button class="btn secondary small" data-do="demo-next">跳到本阶段结算</button>':''}</div></div>`;
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

function privateInfo(g){const info=g.privateInfo||{};return `<div class="private-info">${info.results?.length?`<div class="alert info">查验结果：${info.results.map(r=>`${r.seat} 号 ${escape(r.name)} · ${r.team==='wolf'?'狼人':'好人'}`).join('；')}</div>`:''}${info.wolfTeammates?.length?`<p class="small muted">狼人同伴：${info.wolfTeammates.map(p=>`${p.seat} 号 ${escape(p.name)}`).join('、')}</p>`:''}${info.wolfVotes?.length?`<p class="small muted">队内选择：${info.wolfVotes.map(v=>`${g.players.find(p=>p.id===v.playerId)?.seat} 号 → ${v.targetId?(g.players.find(p=>p.id===v.targetId)?.seat+' 号'):'空刀'}`).join('；')}</p>`:''}${info.potions?`<p class="small muted">解药：${info.potions.save?'可用':'已用'} · 毒药：${info.potions.poison?'可用':'已用'}${info.nightVictim?` · 今夜被袭击：${info.nightVictim.seat} 号 ${escape(info.nightVictim.name)}`:info.nightVictim===null?' · 今夜无人被刀':''}</p>`:''}</div>`;}
function sheriffPanel(g){
  if(!g.config.sheriff)return '';
  const holder=g.players.find(p=>p.id===g.sheriffId),candidates=g.sheriffCandidates||[];
  const election=['sheriff_signup','sheriff_speech','sheriff_vote'].includes(g.phase),transfer=g.phase==='sheriff_transfer',pending=!g.sheriffElectionDone&&g.round===1&&NIGHT_PHASES.includes(g.phase);
  const title=transfer?'警徽移交中':holder?`警长：${holder.seat} 号 ${escape(holder.name)}`:election?'警长竞选'+(g.sheriffRunoff?' · 平票加赛':''):pending?'已开启上警':'当前无警长';
  const help=transfer?'原警长可将警徽交给一名有投票权的存活玩家，或选择撕毁；超时视为撕毁。':election?'竞选结束后公布首夜死讯。上警玩家发言，未报名的警下玩家投票；超时未操作视为放弃。':holder?'警长选择发言方向，放逐票计 1.5 票，常规白天最后发言。':pending?'首夜行动结束后开始竞选，竞选后公布首夜死讯。':'警徽流失后不再重新竞选。';
  return `<div class="sheriff-panel"><strong>${title}</strong><p class="small">${help}${candidates.length&&election?`<br>候选人：${candidates.map(p=>`${p.seat} 号 ${escape(p.name)}`).join('、')}`:''}</p></div>`;
}
function actionPanel(g){
  const speech=['discussion','lastwords','sheriff_speech'].includes(g.phase);
  if(!g.actionable)return `<div class="action-panel"><p>${g.submitted?(NIGHT_PHASES.includes(g.phase)?'已提交，等待本阶段倒计时结束。':'已提交，等待其他玩家完成行动。'):speech?'请等待轮到你发言。可以先在右侧输入草稿。':g.phase==='sheriff_vote'?'等待警下玩家投票。报名上警者即使退水也不能投票。':g.phase==='sheriff_transfer'?'等待原警长移交或撕毁警徽。':g.phase==='sheriff_direction'?'等待警长选择发言方向。':'等待本阶段结束，请留意倒计时。'}</p></div>`;
  if(speech)return `<div class="action-panel"><strong>轮到你${g.phase==='lastwords'?'发表遗言':g.phase==='sheriff_speech'?'竞选发言':'发言'}了</strong><p>展开「相关讨论」输入内容，发言完成后点击「结束发言」。</p></div>`;
  if(g.phase==='sheriff_signup')return `<div class="action-panel"><strong>是否上警竞选警长？</strong><p>上警后将依次发表竞选发言。不上警可为候选人投票；报名超时视为不上警。</p><div class="controls"><button class="btn primary" data-action="join">我要上警</button><button class="btn secondary" data-action="skip">不上警</button></div></div>`;
  if(g.phase==='sheriff_direction')return `<div class="action-panel"><strong>选择本轮发言方向</strong><p>从警长相邻座位开始依次发言，最后由警长发言。左侧按座位号递减，右侧按座位号递增；超时默认从右侧开始。</p><div class="controls"><button class="btn primary" data-action="left">从左侧开始</button><button class="btn primary" data-action="right">从右侧开始</button></div></div>`;
  const action=g.action,targets=action?.targets||[],transfer=g.phase==='sheriff_transfer';
  if(isVoting(g)){
    const voted=g.players.find(p=>p.id===g.myVoteTargetId);
    const summary=g.submitted?(voted?`当前投给 ${voted.seat} 号 ${escape(voted.name)}。`:'当前已弃权。'):'你尚未投票。';
    return `<div class="action-panel"><strong>${escape(g.phaseLabel)}</strong><p>${summary} 点击头像即可投票或换票，截止前也可以改为弃权。</p><button class="btn secondary" data-action="abstain" aria-pressed="${Boolean(g.submitted&&!g.myVoteTargetId)}">弃权</button></div>`;
  }
  const buttons=targets.map(p=>`<button class="target ${state.target===p.id?'selected':''}" data-target="${escape(p.id)}" aria-pressed="${state.target===p.id}">${p.seat} 号 ${escape(p.name)}</button>`).join('');
  const time=action?.deadline?`<span>本次行动剩余 <strong class="timer" data-deadline="${action.deadline}"></strong></span>`:'';
  if(action?.type==='witch'){
    const victim=g.privateInfo?.nightVictim;
    const victimLabel=victim?`${victim.seat} 号 ${escape(victim.name)}`:'';
    return `<div class="action-panel"><strong>女巫行动</strong> ${time}
      ${victim!==undefined?`<p>${victim?`今夜被刀：${victimLabel}`:'今夜无人被刀'}</p>`:''}
      ${victim&&action.choices.includes('save')?`<button class="btn primary" data-action="save">对 ${victimLabel} 使用解药</button>`:''}
      ${action.choices.includes('poison')?`<p>选择用毒目标</p><div class="targets">${buttons}</div><button class="btn danger" data-action="poison" ${!availableTarget(g,state.target)?'disabled':''}>对所选玩家用毒</button>`:''}
      <button class="btn secondary" data-action="skip">放弃行动</button></div>`;
  }
  const label={wolf:'狼队行动',seer:'预言家查验',guard:'守卫守护'}[action?.type]||g.phaseLabel;
  return `<div class="action-panel"><strong>${escape(label)} · ${transfer?'移交或撕毁警徽':'选择目标'}</strong> ${time}${transfer?'<p>选择一位存活玩家接任警长，或撕毁警徽。</p>':''}<div class="targets">${buttons}</div><div class="controls"><button class="btn primary" data-action="confirm" ${!availableTarget(g,state.target)?'disabled':''}>${transfer?'移交给所选玩家':'确认选择'}</button><button class="btn secondary" data-action="skip">${transfer?'撕毁警徽':'放弃行动'}</button></div></div>`;
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
  const g=room.game, isWolf=channel==='wolf', allowed=!state.replay&&(isWolf?Boolean(g?.canWolfChat):Boolean(g?.canSpeak||(!room.isSpectator&&(!g||g.phase==='finished'))));
  let entries=(room.messages||[]).filter(m=>(m.channel||'public')===channel).map(m=>{
    const at=m.at||m.createdAt||0;
    if(m.system)return {at,html:`<div class="system-message">${escape(m.text)}</div>`};
    const seat=m.seat??(g?.players||room.players).find(p=>p.id===m.playerId)?.seat;
    return {at,html:`<div class="chat-message ${isWolf?'wolf-message':''}"><strong>${seat?`${escape(seat)} 号 `:''}${escape(m.name||m.playerName||'玩家')}</strong> ${escape(m.text)}</div>`};
  });
  if(!isWolf)entries=entries.concat((g?.log||[]).map(l=>({at:l.at,html:`<div class="system-message">${escape(l.text)}</div>`}))).sort((a,b)=>a.at-b.at);
  const body = `<div class="chat-feed" id="feed-${channel}">${entries.length?entries.map(e=>e.html).join(''):'<p class="muted small">暂无发言记录。</p>'}</div>${!state.replay&&(!room.isSpectator||allowed)?`<form class="chat-form" data-chat="${channel}"><textarea class="input chat-input" id="draft-${channel}" aria-label="${isWolf?'狼人队内消息':'发言内容'}" maxlength="500" rows="3" placeholder="${allowed?'输入你的发言…':'可以先写草稿，轮到你时再发送…'}">${escape(isWolf?state.wolfDraft:state.draft)}</textarea>${!isWolf&&g?.inactivityDeadline?`<small id="afk-warning" class="form-error" data-inactivity="${g.inactivityDeadline}" hidden></small>`:''}<div class="chat-actions"><small class="muted">${allowed?'可以发言':'当前不能发送'} · 最多 500 字</small><button class="btn primary small" type="submit" ${allowed?'':'disabled'}>发送</button></div>${!isWolf&&g?.canSpeak&&g?.actionable?'<button type="button" class="btn secondary small lg-end-speech" data-do="pass">结束发言</button>':''}</form>`:''}`;
  if (!isWolf) return body;
  return `<section class="card chat-card"><div class="card-header"><strong>狼人队内频道</strong><small class="muted">${g?.phase === 'finished' ? '对局已结束 · 记录公开' : '仅狼人夜间可见'}</small></div>${body}</section>`;
}
// Keep the native textarea and its ancestors mounted while the player writes.
// Removing a focused textarea cancels an IME composition and can scroll a mobile
// browser to the top as the on-screen keyboard closes and reopens.
function renderAroundEditor(root, html, editor) {
  const template = document.createElement('template');
  template.innerHTML = html;
  let current = editor;
  let next = template.content.querySelector('#' + editor.id);
  const path = [];
  while (current && current !== root && next && next !== template.content) {
    if (current.nodeName !== next.nodeName || current.id !== next.id) return false;
    path.push([current, next]);
    current = current.parentNode;
    next = next.parentNode;
  }
  if (current !== root || next !== template.content) return false;

  for (const [live, fresh] of path) {
    for (const name of live.getAttributeNames()) {
      if (!fresh.hasAttribute(name) && !(live === editor && name === 'style')) live.removeAttribute(name);
    }
    for (const {name, value} of fresh.attributes) {
      if (live.getAttribute(name) !== value) live.setAttribute(name, value);
    }

    // A poll may change either side of the field, including controls within
    // its form. Replace those siblings without ever detaching the field.
    const oldNodes = [...live.parentNode.childNodes];
    const newNodes = [...fresh.parentNode.childNodes];
    const oldIndex = oldNodes.indexOf(live), newIndex = newNodes.indexOf(fresh);
    const update = (old, incoming, insert) => {
      if (old.length === incoming.length && old.every((node, i) => node.isEqualNode(incoming[i]))) return;
      old.forEach(node => node.remove());
      live[insert](...incoming);
    };
    update(oldNodes.slice(0, oldIndex), newNodes.slice(0, newIndex), 'before');
    update(oldNodes.slice(oldIndex + 1), newNodes.slice(newIndex + 1), 'after');
  }
  return true;
}

const roomDrafts = new Map();
let draftScope = null, renderedView = null, renderedMarkup = '';
function render(){
  const room = state.room;
  const scope = room && JSON.stringify([state.apiBase, state.player?.id, state.demo, room.code, room.createdAt]);
  if (scope !== draftScope) {
    if (draftScope && (state.draft || state.wolfDraft)) roomDrafts.set(draftScope, {draft:state.draft, wolfDraft:state.wolfDraft});
    const saved = roomDrafts.get(scope);
    state.draft = saved?.draft || '';
    state.wolfDraft = saved?.wolfDraft || '';
    roomDrafts.delete(scope);
    draftScope = scope;
  }
  const view = JSON.stringify([state.page, scope, state.page === 'room' && (state.replay || room)?.code,
    !!state.replay, state.problemTab, state.problemTab === 'submit' && state.submitTab]);
  const sameView = view === renderedView;
  captureCodeEditor();
  const body=state.page==='room'?roomView():state.page==='rules'?`<div class="section-heading"><h1>游戏规则</h1><button class="link-button" data-page="room">返回题目</button></div><section class="card"><div class="card-body">${rules()}</div></section>`:state.page==='history'?`<div class="section-heading"><h1>对局历史</h1><div><button class="link-button" data-page="room">返回题目</button> · <button class="link-button" data-do="refresh">刷新</button></div></div><section class="card">${historyTable([...state.demoHistory,...state.history])}</section>`:lobby();
  const html = shell(body);
  if (sameView && html === renderedMarkup) {
    updateClock();
    return;
  }
  const root = $('#app');
  const focused = sameView ? document.activeElement : null;
  const editing = ['draft-public', 'draft-wolf', 'code-editor'].includes(focused?.id);
  const bounds = editing && focused.getBoundingClientRect?.();
  const anchorTop = bounds && bounds.bottom > 0 && bounds.top < window.innerHeight ? bounds.top : null;
  const oldX = window.scrollX, oldY = window.scrollY;
  const feeds = new Map();
  if (sameView) document.querySelectorAll('.chat-feed').forEach(feed => {
    feeds.set(feed.id, {top:feed.scrollTop, atBottom:feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 2});
  });
  if (!(editing && focused.parentNode && renderAroundEditor(root, html, focused))) root.innerHTML = html;
  updateClock();
  const field = focused?.id && document.getElementById(focused.id);
  if (field && field !== focused) {
    if (focused.value !== undefined) field.value = focused.value;
    field.focus({preventScroll:true});
    if (focused.selectionStart != null && field.setSelectionRange) {
      field.setSelectionRange(focused.selectionStart, focused.selectionEnd, focused.selectionDirection);
      field.scrollTop = focused.scrollTop;
      field.scrollLeft = focused.scrollLeft;
    }
  }
  const editor = document.getElementById('code-editor');
  if (editor && editor !== focused) {
    const position = state.codeSelection;
    editor.setSelectionRange(position.start, position.end);
    editor.scrollTop = position.top;
    editor.scrollLeft = position.left;
  }
  if (editor) syncCodeGutter(editor);
  document.querySelectorAll('.chat-feed').forEach(feed => {
    const old = feeds.get(feed.id);
    feed.scrollTop = !old || old.atBottom ? feed.scrollHeight : old.top;
  });
  if (renderedView !== null) {
    const x = sameView ? oldX : 0;
    const y = anchorTop !== null && field ? window.scrollY + field.getBoundingClientRect().top - anchorTop : sameView ? oldY : 0;
    if (window.scrollX !== x || window.scrollY !== y) window.scrollTo?.(x, y);
  }
  renderedView = view;
  renderedMarkup = html;
}

function updateClock(){
  const now=Date.now();
  document.querySelectorAll('[data-deadline]').forEach(x=>{
    const sec=Math.max(0,Math.ceil((+x.dataset.deadline-now)/1000));
    x.textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
    x.classList.toggle('urgent',sec<=15);
  });
  const warning=$('#afk-warning');
  if(warning){
    const seconds=Math.max(0,Math.ceil((+warning.dataset.inactivity-now)/1000));
    warning.hidden=seconds===0||seconds>15;
    if(!warning.hidden)warning.textContent=`若再 ${seconds} 秒不发言，将被判定为挂机`;
  }
}

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
async function restorePlayerSession() {
  const key = 'token:' + state.apiBase;
  const migrated = 'shared-identity:' + state.apiBase;
  async function resume(token) {
    state.token = token;
    try { return await request('/api/session', {}); }
    catch (error) { if (error.status !== 401) throw error; return null; }
  }
  async function seatPriority(session) {
    if (!session) return 0;
    state.token = session.token;
    const {room, memberships = []} = await request('/api/room');
    if (room && !room.isSpectator && room.game?.phase !== 'finished') {
      if (!room.game) return 1;
      if (room.game.players.some(p => p.id === session.player.id && p.alive)) return 2;
    }
    return memberships.some(m => !m.isSpectator && m.code !== room?.code) ? 1 : 0;
  }
  async function restore() {
    const shared = storage.get(key), legacy = sessionStore.get(key);
    let session = shared ? await resume(shared) : null;
    if (legacy && legacy !== shared && (!session || !sessionStore.get(migrated))) {
      const oldSession = await resume(legacy);
      // If a fresh tab upgraded first, preserve the older player's live game.
      if (!session || (oldSession && await seatPriority(oldSession) > await seatPriority(session))) session = oldSession;
    }
    if (!session) {
      state.token = '';
      session = await request('/api/session', {name:state.name});
    }
    state.token = session.token;
    storage.set(key, session.token);
    sessionStore.set(key, session.token);
    sessionStore.set(migrated, '1');
    return session;
  }
  // Two fresh tabs may connect before either has received its first token.
  return navigator.locks?.request ? navigator.locks.request('moonwolf:' + key, restore) : restore();
}
async function connect({quiet=false}={}){
  if(connectPromise)return connectPromise;
  connectPromise=(async()=>{
    if(!quiet)state.checking=true;
    state.online=false;networkRevision++;render();
    try{
      const health=await request('/api/health');if(health.ok!==true||health.service!=='moonwolf')throw Object.assign(new Error('此地址未返回狼人杀联机服务'), {path:'/api/health'});
      const s=await restorePlayerSession();
      state.token=s.token;state.player=s.player;state.name=s.player.name;storage.set('name',state.name);state.online=true;state.pollFailures=0;state.connectError='';retryDelay=5000;
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
    const pin=state.room?.code||sessionStore.get('room:'+state.apiBase);
    let r;
    try{r=await request(roomPath('/api/room',pin));}
    catch(error){if(!pin||![403,404].includes(error.status))throw error;r=await request('/api/room');}
    if(revision!==networkRevision||state.demo)return;let changed=false;const json=JSON.stringify(r.room);
    if(r.memberships&&JSON.stringify(r.memberships)!==JSON.stringify(state.memberships)){state.memberships=r.memberships;changed=true;}
    sessionStore.set('room:'+state.apiBase,r.room?.code||'');
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
function roomPath(path,code=state.room?.code){return code?`${path}?code=${encodeURIComponent(code)}`:path;}
async function mutation(path,data={}){
  ensureOnline();
  const roomCode=state.room?.code;
  const scoped=['/api/ready','/api/start','/api/seat','/api/action','/api/chat','/api/leave'].includes(path);
  networkRevision++;
  try{
    const result=await request(scoped?roomPath(path,roomCode):path,data);
    networkRevision++;
    // A vote in flight in the old room must not switch this tab back to it.
    if(scoped&&state.room?.code!==roomCode)return result;
    if(result.memberships)state.memberships=result.memberships;
    if('room' in result){
      sessionStore.set('room:'+state.apiBase,result.room?.code||'');
      state.room=result.room;
      lastRoomJson=JSON.stringify(result.room);
    }
    nextPollAt=Date.now()+pollDelay();
    render();
    return result;
  }catch(error){
    if(error.status===401){state.online=false;nextReconnectAt=Date.now()+1000;render();}
    throw error;
  }
}
function settingsModal(){modal('联机设置',`<p class="muted">填写游戏服务器的完整地址。所有玩家使用同一服务器，即可共享匹配队列与房间。</p><form id="settings-form"><label class="field"><span>服务器地址</span><input id="api-base" class="input" type="url" value="${escape(state.apiBase)}" placeholder="https://your-server.example.com"><small class="muted">留空使用网站的默认服务器。</small></label><p class="form-error" id="settings-error"></p><button class="btn primary" type="submit">保存并连接</button></form>`);}
function profileModal(){modal('设置玩家昵称',`<form id="profile-form"><label class="field"><span>昵称（1–16 字）</span><input class="input" id="player-name" value="${escape(state.name)}" maxlength="16" required></label><p class="small muted">同一浏览器标签页会保留你的座位；游戏进行中不能修改昵称。</p><p class="form-error" id="profile-error"></p><button class="btn primary" type="submit">保存昵称</button></form>`);}
function joinModal(code=state.pendingInvite||''){modal(code?'加入好友房间':'输入房号加入',`<form id="join-form"><label class="field"><span>6 位随机房号</span><input class="input room-code-input" id="join-code" name="code" value="${escape(code)}" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="请输入 6 位数字" required></label><p class="small muted">你将以「${escape(state.name)}」加入。可在页面右上角修改昵称。</p><p class="form-error" id="join-error"></p><button class="btn primary full" type="submit">加入房间</button></form>`);}
function createModal(){state.config=copy(STANDARD_CONFIG);modal('自选配置开房',`<form id="create-form"><label class="field"><span>房间名称</span><input id="room-name" class="input" value="${escape(state.name)}的房间" maxlength="30" required></label><div class="config-total"><strong>角色配置 · 共 <span id="total-count">12</span> 人</strong><button type="button" class="link-button" data-do="reset-config">恢复标准局</button></div><div class="role-counters">${roleKeys.map(r=>`<div class="counter-item"><span title="${escape(ROLE_INFO[r].description)}">${badge(r)}</span><button type="button" data-count="${r}" data-delta="-1" aria-label="减少${ROLE_INFO[r].name}">−</button><output id="count-${r}">${state.config.roles[r]??0}</output><button type="button" data-count="${r}" data-delta="1" aria-label="增加${ROLE_INFO[r].name}">＋</button></div>`).join('')}</div><details class="role-help"><summary>查看角色技能</summary><dl>${roleKeys.map(r=>`<dt>${badge(r)}</dt><dd>${escape(ROLE_INFO[r].description)}</dd>`).join('')}</dl></details><label class="check-row"><input type="checkbox" id="shuffle-seats"><span>开局随机重排座位</span></label><label class="check-row sheriff-option"><input type="checkbox" id="sheriff-enabled"><span><strong>开启上警</strong><small>首日竞选警长，可选择发言方向并最后发言、放逐票计 1.5 票，可移交警徽。</small></span></label><div class="form-row"><label class="field"><span>房间类型</span><select id="visibility" class="input"><option value="private">私密房间 · 凭房号加入</option><option value="public">公开房间 · 展示在大厅</option></select></label><label class="field"><span>胜利条件</span><select id="victory" class="input"><option value="side">屠边（标准）</option><option value="all">屠城</option></select></label></div><div class="form-row"><label class="field"><span>狼队行动时间</span><select id="night-seconds" class="input"><option value="60">60 秒</option><option value="75" selected>75 秒</option><option value="90">90 秒</option></select></label><label class="field"><span>其它行动时间</span><select id="other-night-seconds" class="input"><option value="30" selected>30 秒</option><option value="40">40 秒</option><option value="50">50 秒</option></select></label></div><div class="form-row"><label class="field"><span>女巫自救</span><select id="witch-self-save" class="input">${Object.entries(selfSaveLabels).map(([value,label])=>`<option value="${value}" ${value==='first'?'selected':''}>${label}</option>`).join('')}</select></label><label class="field"><span>每人发言时限</span><select id="day-seconds" class="input"><option value="60">60 秒</option><option value="90" selected>90 秒</option><option value="120">120 秒</option></select></label></div><p class="small muted">6–18 人，狼王、白狼王及每种神职各最多 1 人；狼阵营总人数至少 1 人且少于半数。创建后自动生成不重复的 6 位房号。</p><p class="form-error" id="create-error"></p><button class="btn primary full" type="submit">创建房间</button></form>`);}
function updateCounts(){roleKeys.forEach(r=>{const el=$('#count-'+r);if(el)el.textContent=state.config.roles[r]??0;});if($('#total-count'))$('#total-count').textContent=size(state.config);}

function startDemo(){
  if(state.room&&!state.demo){toast('你已在联机房间中，请先离开房间');return;}
  networkRevision++;demoTimeOffset=0;
  state.demo=true;state.replay=null;state.player={id:'local-player',name:state.name};
  const names=['青木','晚风','小橘','长夜','白露','星河','南山','知秋','浮云','阿月','听雨'];
  const players=[{id:'local-player',name:state.name,seat:1,ready:true},...names.map((name,i)=>({id:'bot-'+i,name:'电脑·'+name,seat:i+2,ready:true}))];
  state.demoGame=createGame(players,STANDARD_CONFIG);state.room={code:String(Math.floor(100000+Math.random()*900000)),name:'本地试玩',hostId:'local-player',config:copy(STANDARD_CONFIG),visibility:'private',players,messages:[],game:viewGame(state.demoGame,'local-player')};state.page='room';state.draft='';state.wolfDraft='';closeModal();render();
}
function syncDemo(){
  const game=viewGame(state.demoGame,'local-player');
  for(const [obj,key] of [[game,'deadline'],[game,'inactivityDeadline'],[game.action,'deadline']]){
    if(obj?.[key])obj[key]-=demoTimeOffset;
  }
  state.room.game=game;
  if(state.demoGame.phase==='finished'&&!state.demoHistory.some(x=>x.code===state.room.code)){state.demoHistory.unshift({code:state.room.code,name:state.room.name,winner:state.demoGame.winner,round:state.demoGame.round,endedAt:Date.now(),demo:true,room:copy(state.room)});}render();}
function demoTick(){
  if(!state.demo||!state.demoGame||state.demoGame.phase==='finished')return;
  const g=state.demoGame, before=JSON.stringify(g);advance(g,demoNow());
  if(Date.now()-botTimer>1800){botTimer=Date.now();
    for(const p of g.players.filter(p=>p.id!=='local-player')){
      const v=viewGame(g,p.id);if(!v.actionable||v.submitted)continue;
      try{if(v.action?.type==='pass'){
        state.room.messages.push({name:p.name,seat:p.seat,at:demoNow(),channel:'public',text:v.phase==='lastwords'?'我的遗言结束。请继续推理。':'这是随机行动的试玩电脑。我发言结束。'});act(g,p.id,{type:'pass'},demoNow());break;
      }else{const target=v.action?.targets?.length?v.action.targets[Math.floor(Math.random()*v.action.targets.length)].id:null;const type=v.action.type;act(g,p.id,{type,targetId:type==='witch'?null:target,choice:type==='sheriff_direction'?'right':['witch','sheriff_signup'].includes(type)?'skip':undefined},demoNow());}}
      catch(e){console.warn('Demo action:',e.message);}
    }

  }
  if(JSON.stringify(g)!==before)syncDemo();
}
async function submitAction(payload){if(state.demo){if(payload.turnDeadline!=null)payload.turnDeadline+=demoTimeOffset;act(state.demoGame,'local-player',payload,demoNow());state.target=null;syncDemo();}else{await mutation('/api/action',payload);state.target=null;}}
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
  if (Object.prototype.hasOwnProperty.call(state.sidebar, b.dataset.sidebarToggle)) {
    const key = b.dataset.sidebarToggle;
    state.sidebar[key] = !state.sidebar[key];
    render();
    document.getElementById(b.id)?.focus({preventScroll:true});
    return;
  }
  if (b.dataset.do === 'dismiss-ad') {
    state.adDismissed = true;
    render();
    document.getElementById('toggle-recommendations')?.focus({preventScroll:true});
    return;
  }
  if(b.dataset.problemTab&&['description','submit'].includes(b.dataset.problemTab)){captureCodeEditor();state.problemTab=b.dataset.problemTab;render();return;}
  if(b.dataset.submitTab&&['code','file'].includes(b.dataset.submitTab)){captureCodeEditor();state.problemTab='submit';state.submitTab=b.dataset.submitTab;render();return;}
  if(b.dataset.do==='night-actions'){captureCodeEditor();state.problemTab='submit';state.submitTab='file';render();return;}
  if (b.dataset.do === 'copy-problem') {
    try {
      await navigator.clipboard.writeText(ORIGINAL_PROBLEM_URL);
      toast('题目链接已复制');
    } catch {
      modal('复制题目链接', `<label class="field"><span>洛谷原题</span><input class="input" value="${ORIGINAL_PROBLEM_URL}" readonly></label>`);
    }
    return;
  }
  if(b.dataset.do==='copy-code'){await copyCode();return;}
  if(b.dataset.page){event.preventDefault();await navigate(b.dataset.page);return;}
  if(b.dataset.count){const r=b.dataset.count;state.config.roles[r]=Math.max(0,Math.min(r==='wolf'?6:r==='villager'?12:1,(state.config.roles[r]??0)+Number(b.dataset.delta)));updateCounts();return;}
  if(isVoting(state.room?.game)&&(b.dataset.target||b.dataset.action==='abstain')){
    const g=state.room.game,target=b.dataset.target||null,roomCode=state.room.code,phase=g.phase,turnDeadline=g.deadline;
    if(state.replay||state.room.isSpectator||!g.actionable||target&&!availableTarget(g,target))return;
    ballotQueue=ballotQueue.then(async()=>{
      const now=state.room?.game;
      if(state.replay||state.room?.code!==roomCode||now?.phase!==phase||now.deadline!==turnDeadline||!now.actionable||target&&!availableTarget(now,target))return;
      await submitAction({type:phase,targetId:target,turnDeadline});
    }).catch(e=>toast(e.message));
    await ballotQueue;return;
  }
  if(state.busy)return;
  if(b.dataset.target){selectTarget(b.dataset.target);return;}
  if(b.dataset.skillTarget||b.dataset.skillChoice){if(state.skill){state.skill.targetId=b.dataset.skillTarget||null;renderSkillModal();}return;}
  state.busy=true;b.disabled=true;
  try{
    if(b.dataset.seat){
      if(!state.room||state.replay||state.room.game)throw new Error('开局前才能选择座位');
      await mutation('/api/seat',{seat:Number(b.dataset.seat)});
    }else if(b.dataset.join)await joinRoom(b.dataset.join);
    else if(b.dataset.history){const local=state.demoHistory.find(g=>g.code===b.dataset.history);state.replay=local?local.room:(await request('/api/history/'+encodeURIComponent(b.dataset.history))).room;state.page='room';render();}
    else if(b.dataset.action){
      const a=b.dataset.action,g=state.room?.game,type=g?.action?.type;
      if(state.replay||!g?.actionable||g.submitted||isVoting(g)||!type)throw new Error('当前不能进行此行动');
      if(['confirm','poison'].includes(a)&&!availableTarget(g,state.target))throw new Error('请选择有效目标');
      if(a==='save'&&(!g.privateInfo?.nightVictim||!g.action.choices?.includes('save')))throw new Error('当前不能使用解药');
      const targetId=a==='save'?g.privateInfo.nightVictim.id:['confirm','poison'].includes(a)?state.target:null;
      await submitAction({type,targetId,choice:['witch','sheriff_signup','sheriff_direction'].includes(type)?a:undefined});
    }
    else switch(b.dataset.do){
      case'close-modal':closeModal();break;
      case'profile':profileModal();break;
      case'settings':settingsModal();break;
      case'reconnect':await connect();toast(state.online?'联机连接已恢复':'暂时无法连接，将继续自动重试');break;
      case'join-modal':joinModal();break;
      case'create':createModal();break;
      case'reset-config':state.config=copy(STANDARD_CONFIG);updateCounts();$('#other-night-seconds').value=STANDARD_CONFIG.otherNightSeconds;$('#witch-self-save').value=STANDARD_CONFIG.witchSelfSave;$('#shuffle-seats').checked=false;if($('#sheriff-enabled'))$('#sheriff-enabled').checked=false;if($('#victory'))$('#victory').value=STANDARD_CONFIG.victory;if($('#night-seconds'))$('#night-seconds').value=STANDARD_CONFIG.nightSeconds;if($('#day-seconds'))$('#day-seconds').value=STANDARD_CONFIG.daySeconds;break;
      case'refresh':await refreshData(true);toast('已刷新');break;
      case'match':await mutation('/api/match');state.page='room';state.replay=null;render();break;
      case'ready':await mutation('/api/ready',{ready:!state.room.players.find(p=>p.id===state.player.id)?.ready});break;
      case'start':await mutation('/api/start');break;
      case'leave':if(state.demo){state.demo=false;state.demoGame=null;state.room=null;state.page='lobby';await connect();}else{await mutation('/api/leave');state.page='lobby';render();await refreshData(true);}break;
      case'copy-room':try{await navigator.clipboard.writeText(state.room.code);toast('房号已复制：'+state.room.code);}catch{toast('房号：'+state.room.code);}break;
      case'copy-invite':{const link=invitationUrl(state.room.code);try{await navigator.clipboard.writeText(link);toast('邀请链接已复制，发给朋友即可加入');}catch{modal('邀请好友',`<p class="muted">将下面的链接发给朋友，或分享房号 ${escape(state.room.code)}。</p><label class="field"><span>邀请链接</span><input class="input" value="${escape(link)}" readonly aria-label="邀请链接"></label>`);}break;}
      case'pass':await submitAction({type:'pass',turnDeadline:state.room.game.deadline});break;
      case'return':await submitAction({type:'return'});break;
      case'observe':await mutation('/api/seat',{seat:null});break;
      case'withdraw':await submitAction({type:'withdraw'});break;
      case'duel':skillModal('duel');break;
      case'explode':skillModal('explode');break;
      case'confirm-skill':await confirmSkill();break;
      case'demo':startDemo();break;
      case'demo-next':demoTimeOffset=Math.max(demoTimeOffset,state.demoGame.deadline-Date.now());advance(state.demoGame,demoNow());syncDemo();break;
    }
  }catch(e){toast(e.message);}finally{state.busy=false;if(b.isConnected)b.disabled=false;}
});

let typingTimer, lastTypingSent=0, lastTypingTurn='';
function recordSpeechInput(){
  const room=state.room,g=room?.game;
  if(state.replay||!g?.canSpeak||g.currentSpeakerId!==state.player?.id||g.myAfk||!g.inactivityDeadline)return;
  const turn=`${room.code}:${g.deadline}`;
  const send=async()=>{
    const current=state.room?.game;
    if(state.replay||state.room?.code!==room.code||current?.deadline!==g.deadline||!current.canSpeak||current.myAfk)return;
    lastTypingTurn=turn;lastTypingSent=Date.now();
    try{
      const payload={type:'typing',turnDeadline:g.deadline};
      if(state.demo){await submitAction(payload);return;}
      const result=await request(roomPath('/api/action',room.code),payload);
      const live=state.room?.game,updated=result.room?.game;
      if(state.room?.code===room.code&&live?.deadline===g.deadline&&updated?.deadline===g.deadline&&live.currentSpeakerId===state.player.id&&!live.myAfk&&updated.inactivityDeadline!==undefined){
        live.inactivityDeadline=updated.inactivityDeadline;
        const warning=$('#afk-warning');
        if(warning){warning.dataset.inactivity=updated.inactivityDeadline||0;updateClock();}
      }
    }catch{nextPollAt=Date.now();}
  };
  clearTimeout(typingTimer);
  const wait=lastTypingTurn===turn?1000-(Date.now()-lastTypingSent):0;
  if(wait<=0)void send();
  else typingTimer=setTimeout(send,wait);
}

function saveCodeLanguage(value){if(CODE_LANGUAGES.some(([id])=>id===value)){state.codeLanguage=value;storage.set('codeLanguage',value);}}
document.addEventListener('input',event=>{
  const field=event.target;
  if(field.id==='draft-public'){state.draft=field.value;recordSpeechInput();}
  if(field.id==='draft-wolf')state.wolfDraft=field.value;
  if(field.id==='code-editor'){state.codeDraft=field.value;storage.set('codeDraft',field.value);state.codeSelection={start:field.selectionStart??0,end:field.selectionEnd??0,top:field.scrollTop||0,left:field.scrollLeft||0};const count=$('#code-count');if(count)count.textContent=`${field.value.length} 字符`;syncCodeGutter(field);}
  if(field.id==='code-language')saveCodeLanguage(field.value);
});
document.addEventListener('change',async event=>{if(event.target.id==='switch-room'){try{await joinRoom(event.target.value);}catch(e){toast(e.message);render();}return;}if(event.target.id==='code-language')saveCodeLanguage(event.target.value);});
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
      const config=validateConfig({...state.config,sheriff:$('#sheriff-enabled').checked,victory:$('#victory').value,nightSeconds:+$('#night-seconds').value,otherNightSeconds:+$('#other-night-seconds').value,witchSelfSave:$('#witch-self-save').value,shuffleSeats:$('#shuffle-seats').checked,daySeconds:+$('#day-seconds').value});await mutation('/api/rooms',{name:$('#room-name').value.trim(),config,visibility:$('#visibility').value});closeModal();state.replay=null;state.page='room';render();
    }else if(f.id==='join-form'||f.id==='quick-join'){await joinRoom(new FormData(f).get('code').trim());}
    else if(f.dataset.chat){
      const channel=f.dataset.chat, draftKey=channel==='wolf'?'wolfDraft':'draft', sentDraft=state[draftKey], sentScope=draftScope, text=sentDraft.trim();if(!text)throw new Error('请输入发言内容');
      if(state.demo){const g=state.room.game;if(g.phase!=='finished'&&!(channel==='wolf'?g.canWolfChat:g.canSpeak))throw new Error('当前不能发送消息');state.room.messages.push({name:state.name,seat:g.players.find(p=>p.id===state.player.id)?.seat,text,channel,at:demoNow()});}
      else await mutation('/api/chat',{text,channel});
      if(sentScope===draftScope && state[draftKey]===sentDraft){
        state[draftKey]='';
        const field=$('#draft-'+channel);
        if(field && field.value===sentDraft)field.value='';
      }else if(roomDrafts.get(sentScope)?.[draftKey]===sentDraft){
        roomDrafts.get(sentScope)[draftKey]='';
      }
      render();
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
window.addEventListener('storage', async event => {
  if (event.key !== 'moonwolf:token:' + state.apiBase || event.newValue === state.token || !event.newValue || state.demo) return;
  if (connectPromise) await connectPromise;
  if (!state.demo && storage.get('token:' + state.apiBase) !== state.token) await connect({quiet:true});
});
window.addEventListener('online',()=>{if(!state.demo&&!state.online)connect({quiet:true});});
document.addEventListener('visibilitychange',()=>{nextPollAt=Date.now()+pollDelay();if(document.visibilityState==='visible'&&!state.demo){if(state.online)refreshData();else connect({quiet:true});}});
render();connect();
