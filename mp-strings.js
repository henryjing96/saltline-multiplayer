// Text for the multiplayer layer in both languages. The page language is decided by the server
// (<html lang>), which also translates the game's own text, so one page only ever shows one language.
(() => {
  'use strict';
  const zh = {
    me: '我', player: (id) => '玩家 ' + id, autoName: (id) => '队员 ' + id, hostWord: '房主',
    scout: '侦察员', diver: '突击手', bulwark: '破障手',
    // feed and HUD
    joined: (n) => `<b>${n}</b> 加入了`, left: (n) => `<b>${n}</b> 离开了`,
    youDown: '<b>你</b>倒下了', nowHost: '<b>你</b>现在是房主', backInFight: '重新投入战斗',
    downCount: (n) => `你已倒下 — ${n} 秒后重新部署`,
    hostQuiet: (n) => `${n}（房主）没有响应 — 机器已冻结`,
    labelDown: '倒地', mapExit: '撤',
    kill: (by, victim, head) => `<b>${by}</b> 击倒 <b>${victim}</b>${head ? ' · 爆头' : ''}`,
    fell: (n) => `<b>${n}</b> 倒下了`,
    // lobby panel
    lobbyCoop: '协作大厅', lobbyVersus: '对战大厅', count: (n) => n + ' 人', offline: '未连接',
    editProfile: '编辑玩家资料', changeMode: '更换模式',
    connecting: '正在连接大厅…', reconnecting: '连接已断开，正在重连，可继续单人游玩。', unreachable: '暂未连上房间，可先单人游玩。',
    reconnectingVs: '连接已断开，正在重连…', unreachableVs: '暂未连上房间，正在重试…',
    onlyHostRestart: '只有房主可以重开任务。', waitingFor: (n) => `等待${n}部署…`,
    coopAlone: '可以先部署，也可以等待队友加入。', coopHost: '你是房主，点击“部署”让全队出发。',
    coopJoin: '任务进行中，点击“部署”加入。', coopWait: '等待房主部署。',
    vsNeedTwo: '至少需要 2 人才能开始，把邀请发给对手。', vsPressReady: '点击“准备”，全员准备后同时开始。',
    vsWaitingOn: (names) => `等待 ${names} 准备。`, vsCount: (n) => `全员就绪，${n} 秒后开始。`,
    vsJoin: '对战进行中，点击“加入对战”进场。', vsOver: '本局已结束，马上回到大厅。',
    lastWin: (n, k) => `上一局：${n} 获胜（${k} 次击倒）`, lastDraw: '上一局：平局',
    deploy: '部署', ready: '准备', unready: '取消准备', joinMatch: '加入对战',
    stTitle: '在大厅', stIntro: '部署中', stPlaying: '行动中', stPaused: '暂停', stDead: '倒地', stComplete: '已撤离',
    tagReady: '已准备', tagNotReady: '未准备',
    invite: '邀请', copyInvite: '复制邀请', copied: '已复制', copyFailed: '复制失败，请手动选中链接',
    inviteVersus: (url) => `来 Saltline 对战：${url}`, inviteCoop: (url) => `来 Saltline 协作：${url}`,
    edgeTip: 'Edge 的鼠标手势会抢走右键瞄准：在 Edge 设置里搜索“手势”并关闭，或直接用 F 键瞄准。', dismiss: '不再提示',
    // first screen
    language: '语言', modeLegend: '游戏模式',
    coopName: '协作模式', coopDesc: '组队对抗机器，切断中继后撤离',
    versusName: '对战模式', versusDesc: '个人混战，2 分钟一局，击倒多者胜',
    nameLabel: '玩家显示名', namePlaceholder: '留空自动分配', look: '角色外观',
    solo: '单人游玩', cancel: '取消', save: '保存', enter: '进入大厅',
    titleEdit: '编辑玩家资料', titleJoin: '加入联机大厅',
    // versus HUD
    roundOver: '本局结束', tally: (k, d) => `击倒 ${k} · 阵亡 ${d}`, board: '计分板',
    draw: '本局结束 · 平局', wins: (n) => `本局结束 · ${n} 获胜`,
    thPlayer: '玩家', thKills: '击倒', thDeaths: '阵亡', backIn: (n) => `${n} 秒后回到大厅`,
  };
  const en = {
    me: 'You', player: (id) => 'Player ' + id, autoName: (id) => 'Breacher ' + id, hostWord: 'the host',
    scout: 'Scout', diver: 'Assault', bulwark: 'Bulwark',
    joined: (n) => `<b>${n}</b> joined`, left: (n) => `<b>${n}</b> left`,
    youDown: '<b>You</b> are down', nowHost: '<b>You</b> are now the host', backInFight: 'Back in the fight',
    downCount: (n) => `You are down — redeploying in ${n}`,
    hostQuiet: (n) => `${n} (host) is not responding — machines are frozen`,
    labelDown: 'DOWN', mapExit: 'EX',
    kill: (by, victim, head) => `<b>${by}</b> dropped <b>${victim}</b>${head ? ' · headshot' : ''}`,
    fell: (n) => `<b>${n}</b> went down`,
    lobbyCoop: 'Co-op lobby', lobbyVersus: 'Versus lobby', count: (n) => n + (n === 1 ? ' player' : ' players'), offline: 'Offline',
    editProfile: 'Edit profile', changeMode: 'Change mode',
    connecting: 'Connecting to the lobby…', reconnecting: 'Connection lost. Reconnecting — you can keep playing solo.', unreachable: 'Cannot reach the room yet — you can play solo meanwhile.',
    reconnectingVs: 'Connection lost. Reconnecting…', unreachableVs: 'Cannot reach the room yet. Retrying…',
    onlyHostRestart: 'Only the host can restart the mission.', waitingFor: (n) => `Waiting for ${n} to deploy…`,
    coopAlone: 'Deploy now, or wait for teammates to join.', coopHost: 'You are the host: press Deploy to send the whole team in.',
    coopJoin: 'Mission in progress: press Deploy to join.', coopWait: 'Waiting for the host to deploy.',
    vsNeedTwo: 'A match needs at least 2 players: send the invite to an opponent.', vsPressReady: 'Press Ready. The match starts for everyone once all are ready.',
    vsWaitingOn: (names) => `Waiting for ${names} to be ready.`, vsCount: (n) => `Everyone is ready: starting in ${n}.`,
    vsJoin: 'Match in progress: press Join match to drop in.', vsOver: 'The round is over. Back to the lobby in a moment.',
    lastWin: (n, k) => `Last round: ${n} won (${k} takedowns)`, lastDraw: 'Last round: draw',
    deploy: 'Deploy', ready: 'Ready', unready: 'Not ready', joinMatch: 'Join match',
    stTitle: 'In lobby', stIntro: 'Deploying', stPlaying: 'In action', stPaused: 'Paused', stDead: 'Down', stComplete: 'Extracted',
    tagReady: 'Ready', tagNotReady: 'Not ready',
    invite: 'Invite', copyInvite: 'Copy invite', copied: 'Copied', copyFailed: 'Could not copy: select the link by hand',
    inviteVersus: (url) => `Join my Saltline versus match: ${url}`, inviteCoop: (url) => `Join my Saltline co-op mission: ${url}`,
    edgeTip: 'Edge mouse gestures take over right-click aiming: search “gesture” in Edge settings and turn it off, or aim with F.', dismiss: 'Don’t show again',
    language: 'Language', modeLegend: 'Game mode',
    coopName: 'Co-op', coopDesc: 'Team up against the machines, cut the relays, reach the boat',
    versusName: 'Versus', versusDesc: 'Free-for-all, 2-minute rounds, most takedowns wins',
    nameLabel: 'Display name', namePlaceholder: 'Leave empty for an automatic name', look: 'Operator',
    solo: 'Play solo', cancel: 'Cancel', save: 'Save', enter: 'Enter lobby',
    titleEdit: 'Edit profile', titleJoin: 'Join the LAN lobby',
    roundOver: 'Round over', tally: (k, d) => `Takedowns ${k} · Deaths ${d}`, board: 'Scoreboard',
    draw: 'Round over · Draw', wins: (n) => `Round over · ${n} wins`,
    thPlayer: 'Player', thKills: 'Takedowns', thDeaths: 'Deaths', backIn: (n) => `Back to the lobby in ${n}`,
  };
  const lang = /^zh/i.test(document.documentElement.lang) ? 'zh' : 'en';
  const table = lang === 'zh' ? zh : en;
  window.SaltlineText = {
    lang,
    t(key, ...args) { const v = table[key]; return typeof v === 'function' ? v(...args) : v == null ? key : v; },
    // the choice lives in a cookie so the server can send the matching page
    setLanguage(next) {
      document.cookie = 'saltline.lang=' + (next === 'zh' ? 'zh' : 'en') + '; path=/; max-age=31536000; SameSite=Lax';
      const url = new URL(location.href);
      url.searchParams.delete('lang');
      location.replace(url.pathname + url.search);
    },
  };
})();
