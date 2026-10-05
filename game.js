let drivers = [
  { id: 'demo-a', name: 'Candidato A', party: 'PARTIDO A', votes: 36.2, currentVotes: 36.2, color: '#d7fb51', glow: '#dcff67' },
  { id: 'demo-b', name: 'Candidato B', party: 'PARTIDO B', votes: 31.5, currentVotes: 31.5, color: '#4bafff', glow: '#80ccff' },
  { id: 'demo-c', name: 'Candidato C', party: 'PARTIDO C', votes: 19.2, currentVotes: 19.2, color: '#ff765b', glow: '#ff9a7f' },
  { id: 'demo-d', name: 'Candidato D', party: 'PARTIDO D', votes: 13.1, currentVotes: 13.1, color: '#be85ff', glow: '#d1a5ff' },
];

const DEMO_DRIVERS = drivers.map((driver) => ({ ...driver }));

const canvas = document.querySelector('#race');
const ctx = canvas.getContext('2d');
const standings = document.querySelector('#standings');
const cameraName = document.querySelector('#camera-name');
const cameraButtons = [...document.querySelectorAll('.camera-button')];
const liveButton = document.querySelector('#live-button');
const canvasWrap = document.querySelector('.canvas-wrap');
const fullscreenButton = document.querySelector('#fullscreen-button');
const immersiveBar = document.querySelector('#immersive-bar');
const barStandings = document.querySelector('#bar-standings');
const barListToggle = document.querySelector('#bar-list-toggle');
const barLive = document.querySelector('#bar-live');
const simNote = document.querySelector('.sim-note');
const SIM_NOTE = simNote.textContent;
const countdownCard = document.querySelector('#countdown-card');
const state = {
  mode: 'track', rotation: 0, dpr: 1, width: 0, height: 0,
  started: performance.now(), motion: 0, lastFrame: 0, sectionPct: 38.4, official: false, failures: 0,
  camera: { x: 0, y: 0, zoom: 1, ready: false },
  // 'live' follows the TSE schedule; 'sim' plays a local fictitious count.
  source: 'live', lastOfficial: null, simTimer: 0, simRun: 0,
  // Real-time mode skips the 17h wait and polls the TSE every few seconds.
  realtime: false, resultUrl: null, pollTimer: 0,
  // From 17h BRT on election day real time is forced and cannot be changed.
  locked: false, lockTimer: 0, round: 0,
  // Immersive mode shows only the track, filling the whole screen.
  immersive: false, topInset: 0,
};
const LEADER_ZOOM = 2.6;
const TSE_BASE = 'https://resultados.tse.jus.br';
const ELECTIONS_CONFIG_URL = `${TSE_BASE}/oficial/comum/config/ele-c.json`;
const POLL_INTERVAL = 30_000;
const REALTIME_INTERVAL = 5_000;
// After 17h, how long the automatic switch has before the manual button shows.
const LIVE_FALLBACK_GRACE_MS = 30_000;
const LIVE_FALLBACK_FAILURES = 3;
// Minutes without a new TSE file before the page says the data is stale.
const STALE_RESULT_MINUTES = 10;
// 2026 rounds; replaced by the dates in the TSE configuration when it loads.
const DEFAULT_ROUND_DATES = { 1: '04/10/2026', 2: '25/10/2026' };
const MAX_TIMER_DELAY = 2 ** 31 - 1;
const MAX_RETRY_INTERVAL = 10 * 60_000;
const kartPalette = [
  ['#d7fb51', '#dcff67'], ['#4bafff', '#80ccff'], ['#ff765b', '#ff9a7f'],
  ['#be85ff', '#d1a5ff'], ['#ffc857', '#ffdc82'], ['#45dbc1', '#7ffff0'],
  ['#ff6da8', '#ff9bc2'], ['#93a9ff', '#c4d0ff'], ['#ff984b', '#ffc18a'],
  ['#a4db58', '#ccf28a'],
];

const formatVote = (value) => value.toFixed(1).replace('.', ',');

// Last rank of each candidate and when it changed, for the ▲/▼ markers.
const rankHistory = new Map();
const RANK_MOVE_MS = 8000;

function buildStandings() {
  const fragment = document.createDocumentFragment();
  const leaderVotes = drivers[0]?.votes || 1;
  const now = Date.now();
  drivers.forEach((driver, index) => {
    const row = document.createElement('li');
    row.className = `racer-row ${index === 0 ? 'is-leader' : ''} ${driver.outcome ? `is-${driver.outcome}` : ''}`;
    row.style.setProperty('--kart', driver.color);
    row.style.setProperty('--row-tint', driver.color);
    row.innerHTML = `<span class="rank"><span class="rank-number"></span><span class="rank-move"></span></span><span class="mini-kart" aria-hidden="true"></span><span class="driver"><span class="driver-name"></span><span class="driver-party"></span><span class="outcome-tag" hidden></span></span><span class="vote-cell"><span class="vote-main"><span class="vote-value"></span><span class="vote-count"></span></span><span class="vote-gap"></span></span><span class="vote-bar" aria-hidden="true"><span></span></span>`;
    row.querySelector('.rank-number').textContent = String(index + 1).padStart(2, '0');
    row.querySelector('.driver-name').textContent = driver.name;
    row.querySelector('.driver-party').textContent = driver.party;
    if (driver.outcome) {
      const tag = row.querySelector('.outcome-tag');
      tag.hidden = false;
      tag.textContent = OUTCOME_LABELS[driver.outcome];
    }
    row.querySelector('.vote-value').textContent = `${formatVote(driver.votes)}%`;
    row.querySelector('.vote-count').textContent = Number.isFinite(driver.voteCount)
      ? new Intl.NumberFormat('pt-BR').format(driver.voteCount)
      : '—';
    row.querySelector('.vote-count').title = Number.isFinite(driver.voteCount) ? `${new Intl.NumberFormat('pt-BR').format(driver.voteCount)} votos` : 'Votos indisponíveis na demonstração';
    row.querySelector('.vote-gap').textContent = index === 0 ? 'LÍDER' : `−${formatVote(leaderVotes - driver.votes)}`;
    row.querySelector('.vote-bar span').style.width = `${Math.max(2, (driver.votes / leaderVotes) * 100)}%`;
    const past = rankHistory.get(driver.id);
    const move = past && past.index !== index ? { index, delta: past.index - index, at: now } : { ...past, index };
    rankHistory.set(driver.id, move);
    if (move.delta && now - move.at < RANK_MOVE_MS) {
      const marker = row.querySelector('.rank-move');
      marker.classList.add(move.delta > 0 ? 'up' : 'down');
      marker.textContent = `${move.delta > 0 ? '▲' : '▼'}${Math.abs(move.delta)}`;
      marker.title = move.delta > 0 ? 'Subiu de posição' : 'Caiu de posição';
    }
    fragment.append(row);
  });
  standings.replaceChildren(fragment);
  buildBarStandings();
  document.querySelector('#racer-count').innerHTML = `${String(drivers.length).padStart(2, '0')} <small>KARTS</small>`;
  const leader = drivers[0];
  if (leader) {
    const card = document.querySelector('#leader-card');
    document.querySelector('#leader-name').textContent = leader.name;
    document.querySelector('#leader-party').textContent = leader.party;
    document.querySelector('#leader-vote').textContent = `${formatVote(leader.votes)}%`;
    const second = drivers[1];
    document.querySelector('#leader-gap').textContent = second ? `+${formatVote(leader.votes - second.votes)} pts sobre o 2º` : '';
    card.style.setProperty('--leader', leader.color);
    card.classList.toggle('is-decided', Boolean(leader.outcome));
    let title = 'LÍDER DA CORRIDA';
    if (leader.outcome === 'elected') {
      title = state.resultRound === '1' ? 'ELEITO NO 1º TURNO' : 'ELEITO PRESIDENTE';
    } else if (leader.outcome === 'runoff') {
      title = 'VAI AO 2º TURNO';
      const rival = drivers.find((driver) => driver !== leader && driver.outcome === 'runoff');
      if (rival) document.querySelector('#leader-gap').textContent = `2º turno contra ${rival.name}`;
    }
    document.querySelector('#leader-title').textContent = title;
  }
}

// Compact standings shown over the corner (or, on phones, above) the full-screen track.
function buildBarStandings() {
  const fragment = document.createDocumentFragment();
  drivers.forEach((driver, index) => {
    const item = document.createElement('li');
    item.className = `bar-racer ${index === 0 ? 'is-leader' : ''} ${driver.outcome ? `is-${driver.outcome}` : ''}`;
    item.style.setProperty('--kart', driver.color);
    item.innerHTML = '<span class="bar-rank"></span><span class="bar-name"></span><span class="bar-vote"><span class="bar-percent"></span><small class="bar-count"></small></span>';
    item.querySelector('.bar-rank').textContent = String(index + 1).padStart(2, '0');
    item.querySelector('.bar-name').textContent = driver.name;
    item.querySelector('.bar-name').title = `${driver.name} · ${driver.party}${driver.outcome ? ` · ${OUTCOME_LABELS[driver.outcome]}` : ''}`;
    if (driver.outcome) item.querySelector('.bar-rank').textContent = driver.outcome === 'elected' ? '✓' : '2T';
    item.querySelector('.bar-percent').textContent = `${formatVote(driver.votes)}%`;
    item.querySelector('.bar-count').textContent = Number.isFinite(driver.voteCount)
      ? new Intl.NumberFormat('pt-BR').format(driver.voteCount)
      : '—';
    item.querySelector('.bar-count').title = Number.isFinite(driver.voteCount) ? `${new Intl.NumberFormat('pt-BR').format(driver.voteCount)} votos` : 'Votos indisponíveis na demonstração';
    fragment.append(item);
  });
  barStandings.replaceChildren(fragment);
}

// Updates the header status pill; `kind` picks its color (demo, official, sim, stale).
function setStatusBadge(kind, text) {
  const badge = document.querySelector('.demo-tag');
  badge.dataset.state = kind;
  badge.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${text}`;
}

function displayOfficialStatus(isOfficial, message = '') {
  state.official = isOfficial;
  const label = document.querySelector('#source-label');
  const detail = document.querySelector('#source-detail');
  setStatusBadge(isOfficial ? 'official' : 'demo', isOfficial ? 'DADOS OFICIAIS DO TSE' : 'MODO DEMONSTRAÇÃO');
  label.textContent = isOfficial ? 'FONTE OFICIAL · TSE' : 'DADOS ILUSTRATIVOS';
  detail.textContent = message || (isOfficial ? 'Resultado nacional · arquivo EA20' : 'Aguardando dados oficiais');
}

function parseTseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const number = Number.parseFloat(String(value ?? '0').replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

// Returns the presidential elections of 2026 keyed by round (1 and, once the
// TSE configures it, 2).
function findPresidentialElections(config) {
  const rounds = {};
  for (const cycle of config.pl || []) {
    if (cycle.c !== 'ele2026') continue;
    for (const election of cycle.e || []) {
      const hasPresident = (election.abr || []).some((scope) =>
        scope.cd === 'br' && (scope.cp || []).some((office) => String(office.cd).padStart(4, '0') === '0001'));
      const round = String(election.t);
      if (hasPresident && (round === '1' || round === '2')) {
        rounds[round] = {
          cycle: cycle.c, electionCode: String(election.cd),
          date: election.dt || (round === '1' ? cycle.dt : null),
        };
      }
    }
  }
  if (!rounds[1] && !rounds[2]) throw new Error('A eleição presidencial de 2026 ainda não aparece na configuração do TSE.');
  return rounds;
}

function buildResultUrl(config, election, filename) {
  const template = (config.arq || []).find((file) => file.tp === 'u');
  if (!template?.dir) throw new Error('A configuração do TSE não contém o diretório do arquivo EA20.');
  const directory = template.dir
    .replaceAll('<base>', TSE_BASE)
    .replaceAll('<ambiente>', 'oficial')
    .replaceAll('<ciclo>', election.cycle)
    .replaceAll('<cd_eleicao>', election.electionCode)
    .replaceAll('<uf>', 'br');
  return `${directory}/${filename}`;
}

// The TSE marks each candidate's situation (`st`, `e`); `md` says the result
// is mathematically defined. On election night `md` can arrive before `st`.
const OUTCOME_LABELS = { elected: 'ELEITO', runoff: '2º TURNO' };
const OUTCOME_SHORT = { elected: '✓', runoff: '2T' };

function candidateOutcome(candidate) {
  const status = String(candidate.st || '').toLowerCase();
  if (/2[ºo°]\s*turno|segundo turno/.test(status)) return 'runoff';
  if (candidate.e === 's' || (status.includes('eleito') && !/n[ãa]o/.test(status))) return 'elected';
  return '';
}

// Only when the TSE says the result is defined (`md`) or the count reached
// 100%, but `st` is still empty: more than half of the valid votes elects; otherwise the top two go to
// the runoff (first round only).
function applyDefinedOutcome(result, candidateDrivers) {
  const complete = result.tf === 's' || parseTseNumber(result.s?.pst) >= 100;
  if ((result.md !== 's' && !complete) || candidateDrivers.some((driver) => driver.outcome)) return;
  const validTotal = candidateDrivers.reduce((total, driver) => total + driver.voteCount, 0);
  const ranked = [...candidateDrivers].sort((a, b) => b.voteCount - a.voteCount);
  if (!validTotal || !ranked.length) return;
  if (ranked[0].voteCount / validTotal > .5 || String(result.t) === '2') ranked[0].outcome = 'elected';
  else ranked.slice(0, 2).forEach((driver) => { driver.outcome = 'runoff'; });
}

function flattenCandidates(result) {
  const presidential = (result.carg || []).find((office) => String(office.cd).padStart(4, '0') === '0001');
  if (!presidential) throw new Error('O arquivo EA20 ainda não contém o cargo de presidente.');
  const votes = result.v || {};
  const validVotes = parseTseNumber(votes.vv);
  const blankVotes = parseTseNumber(votes.vb);
  const nullVotes = parseTseNumber(votes.vn);
  const candidates = (presidential.agr || []).flatMap((group) =>
    (group.par || []).flatMap((party) =>
      (party.cand || []).map((candidate) => ({ candidate, party, group }))));
  const usable = candidates.filter(({ candidate }) => !String(candidate.dvt || '').toLowerCase().includes('anulado'));
  const candidateVoteTotal = usable.reduce((total, item) => total + parseTseNumber(item.candidate.vap), 0);
  const voteTotal = parseTseNumber(votes.tv) || validVotes + blankVotes + nullVotes || validVotes || candidateVoteTotal;
  const candidateDrivers = usable.map(({ candidate, party, group }, index) => {
    const votesCount = parseTseNumber(candidate.vap);
    const old = drivers.find((driver) => driver.id === String(candidate.sqcand || candidate.n));
    const colorPair = old ? [old.color, old.glow] : kartPalette[index % kartPalette.length];
    return {
      id: String(candidate.sqcand || candidate.n || index),
      name: candidate.nmu || candidate.nm || 'Candidatura',
      party: party.sg || group.com || group.nm || 'PARTIDO',
      votes: voteTotal ? votesCount / voteTotal * 100 : 0,
      voteCount: votesCount,
      outcome: candidateOutcome(candidate),
      validPct: parseTseNumber(candidate.pvapn || candidate.pvap),
      currentVotes: old?.currentVotes ?? (voteTotal ? votesCount / voteTotal * 100 : 0),
      color: colorPair[0], glow: colorPair[1],
    };
  });
  applyDefinedOutcome(result, candidateDrivers);
  const specialDrivers = [
    { id: 'tse-blank', name: 'Brancos', party: 'VOTOS EM BRANCO', count: blankVotes, color: '#f5f7fa', glow: '#ffffff' },
    { id: 'tse-null', name: 'Nulos', party: 'VOTOS NULOS', count: nullVotes, color: '#a8b2c2', glow: '#d2d9e3' },
  ].map(({ id, name, party, count, color, glow }) => {
    const old = drivers.find((driver) => driver.id === id);
    const share = voteTotal ? count / voteTotal * 100 : 0;
    return {
      id, name, party, voteCount: count, votes: share,
      currentVotes: old?.currentVotes ?? share,
      color: old?.color ?? color, glow: old?.glow ?? glow,
    };
  });
  return [...candidateDrivers, ...specialDrivers].sort((a, b) => b.votes - a.votes);
}

function updateOfficialMetadata(result) {
  const sectionPct = Math.min(100, Math.max(0, parseTseNumber(result.s?.pst)));
  state.sectionPct = sectionPct;
  document.querySelector('#sections-percent').textContent = `${formatVote(sectionPct)}%`;
  document.querySelector('#sections-progress').style.width = `${sectionPct}%`;
  const totalVotes = parseTseNumber(result.v?.tv) || parseTseNumber(result.v?.vv);
  document.querySelector('#total-votes').textContent = totalVotes
    ? `${new Intl.NumberFormat('pt-BR').format(totalVotes)} votos`
    : '— votos';
  const timestamp = `${result.dg || ''} ${result.hg || ''}`.trim();
  document.querySelector('#last-update').textContent = timestamp || 'Atualizado pelo TSE';
  document.querySelector('#source-detail').textContent = `Brasil · EA20 · geração ${timestamp || 'informada pelo TSE'}`;
  state.resultRound = String(result.t || state.round || '1');
  if (result.tf === 's') {
    document.querySelector('.lap-counter strong').innerHTML = 'FINAL <i>✓</i>';
  } else if (result.md === 's') {
    document.querySelector('.lap-counter strong').innerHTML = 'DEFINIDO <i>⚑</i>';
  } else {
    document.querySelector('.lap-counter strong').innerHTML = '01 <i>/</i> 01';
  }
}

async function connectToTse() {
  try {
    const configResponse = await fetch(ELECTIONS_CONFIG_URL, { cache: 'no-cache' });
    if (!configResponse.ok) throw new Error(`Configuração do TSE indisponível (${configResponse.status}).`);
    const config = await configResponse.json();
    const elections = findPresidentialElections(config);
    [1, 2].forEach((round) => {
      if (elections[round]?.date) state.roundDates[round] = elections[round].date;
    });
    const { round } = realtimeWindow();
    const election = elections[round] || elections[1] || elections[2];
    const code = election.electionCode.padStart(6, '0');
    state.resultUrl = buildResultUrl(config, election, `br-c0001-e${code}-u.json`);
    state.electionDate = state.roundDates[round];
    const wasLocked = state.locked;
    scheduleRealtimeLock();
    // Locking already started polling the TSE.
    if (!wasLocked && state.locked) return;
    const delay = state.realtime ? 0 : delayUntilDisclosure(state.electionDate);
    if (delay > 0) {
      if (state.source === 'live') displayOfficialStatus(false, 'A divulgação do TSE começa às 17h BRT · placar ilustrativo');
      schedulePoll(pollTseResults, delay);
    } else {
      await pollTseResults();
    }
  } catch (error) {
    if (state.source === 'live') displayOfficialStatus(false, 'Não foi possível conectar ao TSE; placar ilustrativo');
    console.info('A corrida continua em modo demonstração.', error);
    schedulePoll(connectToTse, state.realtime ? REALTIME_INTERVAL : POLL_INTERVAL);
  }
}

// Keeps a single pending TSE request, so real-time mode can reschedule it.
function schedulePoll(task, delay) {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = window.setTimeout(task, delay);
}

function refreshFromTse() {
  window.clearTimeout(state.pollTimer);
  if (state.resultUrl) pollTseResults();
  else connectToTse();
}

// Arms (or immediately applies) the switch to locked real time at 17h BRT.
function brasiliaTime(dateText, hour) {
  const [day, month, year] = String(dateText || '').split('/').map(Number);
  if (!day || !month || !year) return NaN;
  const pad = (value) => String(value).padStart(2, '0');
  return Date.parse(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:00:00-03:00`);
}

// Real time is locked from 17h BRT of a round's day. The first round's lock
// ends at midnight of the second round's day, so that morning is free again
// until its own 17h disclosure.
function realtimeWindow() {
  const round = Date.now() >= brasiliaTime(state.roundDates[2], 0) ? 2 : 1;
  return {
    round,
    start: brasiliaTime(state.roundDates[round], 17),
    end: round === 1 ? brasiliaTime(state.roundDates[2], 0) : Infinity,
  };
}

// Applies the lock for the current moment and arms a timer for the next
// change. Returns true when the round changed.
function scheduleRealtimeLock() {
  window.clearTimeout(state.lockTimer);
  const { round, start, end } = realtimeWindow();
  const roundChanged = state.round !== round;
  state.round = round;
  state.electionDate = state.roundDates[round];
  const now = Date.now();
  if (now >= start) lockRealtime();
  else if (state.locked) unlockRealtime();
  const next = now < start ? start : end;
  // Long delays are re-evaluated in steps; setTimeout cannot wait longer.
  if (Number.isFinite(next)) state.lockTimer = window.setTimeout(onRealtimeTimer, Math.min(next - now, MAX_TIMER_DELAY));
  return roundChanged;
}

function updateCountdown() {
  const { round, start } = realtimeWindow();
  const remaining = Math.max(0, Math.ceil((start - Date.now()) / 1000));
  updateLiveButton();
  if (state.locked || remaining === 0) {
    if (!state.locked) scheduleRealtimeLock();
    countdownCard.classList.add('is-live');
    document.querySelector('#countdown-label').textContent = 'APURAÇÃO EM TEMPO REAL';
    document.querySelector('#countdown-detail').textContent = state.official
      ? 'Dados oficiais do TSE · atualiza a cada 5 segundos'
      : 'Consulta automática ativa · aguardando dados do TSE';
    return;
  }

  countdownCard.classList.remove('is-live');
  document.querySelector('#countdown-label').textContent = 'APURAÇÃO EM TEMPO REAL COMEÇA EM';
  document.querySelector('#countdown-detail').textContent = round === 1
    ? 'Hoje, às 17h · horário de Brasília'
    : 'Segundo turno · às 17h · horário de Brasília';
  document.querySelector('#countdown-days').textContent = String(Math.floor(remaining / 86400)).padStart(2, '0');
  document.querySelector('#countdown-hours').textContent = String(Math.floor((remaining % 86400) / 3600)).padStart(2, '0');
  document.querySelector('#countdown-minutes').textContent = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
  document.querySelector('#countdown-seconds').textContent = String(remaining % 60).padStart(2, '0');
}

function onRealtimeTimer() {
  if (!scheduleRealtimeLock()) return;
  // A new round starts: drop the previous round's result and load the new file.
  state.lastOfficial = null;
  state.resultUrl = null;
  if (state.source === 'live') showDemoResults();
  connectToTse();
}

function lockRealtime() {
  if (state.locked) return;
  state.locked = true;
  if (state.source === 'sim') stopSimulation();
  state.realtime = true;
  updateLiveButton();
  simNote.textContent = `Divulgação oficial do ${state.round}º turno iniciada às 17h (horário de Brasília): `
    + 'o modo tempo real fica fixo e consulta o TSE a cada 5 segundos.';
  refreshFromTse();
}

function unlockRealtime() {
  state.locked = false;
  state.realtime = false;
  updateLiveButton();
  simNote.textContent = SIM_NOTE;
  // Back before a disclosure: the warm-up simulation runs again.
  if (state.source === 'live') startSimulation();
}

// The real-time button is only a fallback: it appears after 17h when the
// automatic switch did not happen or the TSE data is not arriving.
function liveFallbackNeeded() {
  const { start } = realtimeWindow();
  if (!(Date.now() >= start + LIVE_FALLBACK_GRACE_MS)) return false;
  return !state.locked || !state.official || state.failures >= LIVE_FALLBACK_FAILURES;
}

function updateLiveButton() {
  const show = liveFallbackNeeded();
  liveButton.hidden = !show;
  barLive.parentElement.hidden = !show;
  if (!show) return;
  liveButton.textContent = state.locked ? '↻ Tentar conectar ao TSE' : '● Começar tempo real';
  barLive.textContent = state.locked ? '↻ Reconectar' : '● Tempo real';
}

function startRealtimeManually() {
  if (state.locked) refreshFromTse();
  else lockRealtime();
  updateLiveButton();
}

function delayUntilDisclosure(dateText) {
  const [day, month, year] = String(dateText || '').split('/').map(Number);
  if (!day || !month || !year) return 0;
  const disclosureTime = Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T17:00:00-03:00`);
  return Math.max(0, disclosureTime - Date.now());
}

// Renders an EA20 result and flashes the leader card on an overtake.
function applyResult(result) {
  const previousLeaderId = drivers[0]?.id;
  const nextDrivers = flattenCandidates(result);
  const isSameField = nextDrivers.some((driver) => driver.id === previousLeaderId);
  drivers = nextDrivers;
  updateOfficialMetadata(result);
  buildStandings();
  if (isSameField && nextDrivers[0]?.id !== previousLeaderId) {
    const card = document.querySelector('#leader-card');
    card.classList.remove('overtake');
    void card.offsetWidth;
    card.classList.add('overtake');
    window.setTimeout(() => card.classList.remove('overtake'), 1800);
  }
}

function applyOfficialResult(result) {
  applyResult(result);
  displayOfficialStatus(true, `Brasil · EA20 · gerado ${result.hg || 'horário indisponível'}`);
  flagStaleResult(result);
  updateFinalScreen(result);
}

// Once the official file reaches 100% of the sections (or the final
// totalization), or the TSE marks the result as mathematically defined (`md`),
// a full screen shows who was elected or goes to the runoff.
// It opens by itself once per round; afterwards the leader card reopens it.
const finalScreen = document.querySelector('#final-screen');
const finalOpen = document.querySelector('#final-open');

function updateFinalScreen(result) {
  const complete = result.tf === 's' || parseTseNumber(result.s?.pst) >= 100;
  const defined = result.md === 's';
  const decided = drivers.filter((driver) => driver.outcome);
  const ready = (complete || defined) && decided.length > 0;
  finalOpen.hidden = !ready;
  if (!ready) return;
  const round = String(result.t || state.round || '1');
  const elected = decided.find((driver) => driver.outcome === 'elected');
  const shown = elected ? [elected] : decided.filter((driver) => driver.outcome === 'runoff').slice(0, 2);
  document.querySelector('#final-kicker').textContent = `PRESIDENTE · BRASIL 2026 · RESULTADO DO ${round}º TURNO`;
  document.querySelector('#final-title').textContent = elected
    ? (round === '1' ? 'ELEITO NO 1º TURNO' : 'PRESIDENTE ELEITO')
    : 'VÃO AO 2º TURNO';
  const cards = document.createDocumentFragment();
  shown.forEach((driver, index) => {
    if (index > 0) {
      const versus = document.createElement('span');
      versus.className = 'final-versus';
      versus.textContent = 'VS';
      cards.append(versus);
    }
    const card = document.createElement('article');
    card.className = 'final-card';
    card.style.setProperty('--kart', driver.color);
    card.innerHTML = '<span class="final-rank"></span><strong class="final-name"></strong><span class="final-party"></span><strong class="final-vote"></strong><span class="final-count"></span>';
    card.querySelector('.final-rank').textContent = `${index + 1}º COLOCADO`;
    card.querySelector('.final-name').textContent = driver.name;
    card.querySelector('.final-party').textContent = driver.party;
    card.querySelector('.final-vote').textContent = `${formatVote(driver.validPct || driver.votes)}%`;
    card.querySelector('.final-count').textContent =
      `${new Intl.NumberFormat('pt-BR').format(driver.voteCount)} votos · ${driver.validPct ? 'dos votos válidos' : 'do total'}`;
    cards.append(card);
  });
  document.querySelector('#final-cards').replaceChildren(cards);
  const runoffDate = state.roundDates?.[2];
  document.querySelector('#final-meta').textContent = [
    !complete ? 'Resultado matematicamente definido pelo TSE' : '',
    `${formatVote(parseTseNumber(result.s?.pst))}% das seções totalizadas`,
    `gerado ${result.dg || ''} ${result.hg || ''}`.trim(),
    !elected && round === '1' && runoffDate ? `2º turno em ${runoffDate}` : '',
  ].filter(Boolean).join(' · ');
  const key = `${result.ele || ''}-${round}`;
  if (state.finalShownFor !== key) {
    state.finalShownFor = key;
    showFinalScreen(true);
  }
}

function showFinalScreen(on) {
  finalScreen.hidden = !on;
  document.body.classList.toggle('has-final', on);
  if (on) document.querySelector('#final-states').focus();
}

finalOpen.addEventListener('click', () => showFinalScreen(true));

// The TSE can keep answering with an old file; flag it once the generation
// time is too far behind (the final totalization is not expected to change).
function flagStaleResult(result) {
  const [day, month, year] = String(result.dg || '').split('/').map(Number);
  const generated = Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${result.hg}-03:00`);
  if (!Number.isFinite(generated) || result.tf === 's') return;
  const minutes = Math.floor((Date.now() - generated) / 60_000);
  if (minutes < STALE_RESULT_MINUTES) return;
  setStatusBadge('stale', 'TSE SEM ATUALIZAÇÃO');
  document.querySelector('#source-detail').textContent =
    `Arquivo do TSE sem mudança há ${minutes} min · gerado ${result.hg}`;
}

function showDemoResults() {
  drivers = DEMO_DRIVERS.map((demo) => ({
    ...demo,
    currentVotes: drivers.find((driver) => driver.id === demo.id)?.currentVotes ?? 0,
  }));
  state.sectionPct = 38.4;
  document.querySelector('#sections-percent').textContent = '38,4%';
  document.querySelector('#sections-progress').style.width = '38.4%';
  document.querySelector('#total-votes').textContent = '— votos';
  document.querySelector('#last-update').innerHTML = 'DEMO <small>sem horário oficial</small>';
  document.querySelector('.lap-counter strong').innerHTML = '01 <i>/</i> 01';
  buildStandings();
  const message = delayUntilDisclosure(state.electionDate) > 0
    ? 'A divulgação do TSE começa às 17h BRT · placar ilustrativo'
    : 'Aguardando publicação oficial · placar ilustrativo';
  displayOfficialStatus(false, message);
}

// "Simular apuração" replays the TSE's official test environment (simulado
// 2026, election 21270): it loads the final presidential file published there
// and plays the count from 0% up to it. If that file is unavailable, a local
// fictitious race is used instead. Both emit EA20-shaped files, so the race
// follows the same path as real TSE data.
const TSE_SIM_RESULT_URL = 'https://resultados-sim.tse.jus.br/simulado/simulado2026/ele2026/21270/dados/br/br-c0001-e021270-u.json';
const LOCAL_SIM_CANDIDATES = [
  { n: '11', nm: 'Candidato A', sg: 'PARTIDO A', final: 38.4, early: -.17 },
  { n: '22', nm: 'Candidato B', sg: 'PARTIDO B', final: 34.1, early: .22 },
  { n: '33', nm: 'Candidato C', sg: 'PARTIDO C', final: 12.2, early: -.12 },
  { n: '44', nm: 'Candidato D', sg: 'PARTIDO D', final: 7.6, early: .08 },
  { n: '55', nm: 'Candidato E', sg: 'PARTIDO E', final: 4.9, early: .05 },
  { n: '66', nm: 'Candidato F', sg: 'PARTIDO F', final: 2.8, early: -.02 },
];
const LOCAL_SIM_VALID_VOTES = 118_000_000;
const SIM_STEP_MS = 1500;
// Pause on the finished warm-up lap before the count starts over.
const SIM_LOOP_PAUSE_MS = 6000;

// Section progress for the next step: the count starts slowly, speeds up
// mid-way and eases into the final sections, like a warm-up lap.
function nextSimPct(pct) {
  const next = pct + .3 + 2.4 * Math.sin(Math.PI * pct / 100) ** 2;
  return next > 99.6 ? 100 : next;
}

// Each warm-up lap gets a fresh early skew, so the overtakes change every loop.
function reshuffleSimScenario(scenario) {
  scenario.candidates.forEach((candidate) => {
    candidate.early = (Math.random() - .5) * .5;
  });
}

function localSimScenario() {
  return {
    source: 'local',
    finalFile: null,
    candidates: LOCAL_SIM_CANDIDATES.map((candidate) => ({
      sqcand: `sim-${candidate.n}`, n: candidate.n, nmu: candidate.nm, sg: candidate.sg, dvt: 'Válido',
      finalVap: Math.round(LOCAL_SIM_VALID_VOTES * candidate.final / 100), early: candidate.early,
    })),
  };
}

async function loadTseSimScenario() {
  const response = await fetch(TSE_SIM_RESULT_URL, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Simulado do TSE indisponível (${response.status}).`);
  const finalFile = await response.json();
  if (finalFile.f !== 's') throw new Error('O arquivo consultado não pertence ao simulado.');
  const presidential = (finalFile.carg || []).find((office) => String(office.cd).padStart(4, '0') === '0001');
  const candidates = (presidential?.agr || []).flatMap((group) =>
    (group.par || []).flatMap((party) => (party.cand || []).map((candidate) => ({
      sqcand: String(candidate.sqcand || candidate.n), n: candidate.n, nmu: candidate.nmu || candidate.nm,
      sg: party.sg || group.com || group.nm, dvt: candidate.dvt || 'Válido',
      finalVap: parseTseNumber(candidate.vap),
      // Early sections over-represent some regions: shares start skewed and
      // drift to the final result, which produces overtakes along the way.
      early: (Math.random() - .5) * .5,
    }))));
  if (!candidates.length) throw new Error('O simulado do TSE não contém candidatos a Presidente.');
  return { source: 'tse', finalFile, candidates };
}

function buildSimulatedResult(scenario, pct) {
  if (pct >= 100 && scenario.finalFile) return scenario.finalFile;
  const progress = pct / 100;
  const drift = (1 - progress) ** 1.4;
  const counted = scenario.candidates.map((candidate) => Math.round(
    candidate.finalVap * progress * Math.max(.05, 1 + candidate.early * drift + (Math.random() - .5) * .02 * drift)));
  const validVotes = scenario.candidates.reduce((total, candidate, index) =>
    total + (String(candidate.dvt).toLowerCase().includes('anulado') ? 0 : counted[index]), 0);
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return {
    f: 's',
    tf: pct >= 100 ? 's' : 'n',
    dg: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`,
    hg: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    s: { pst: pct.toFixed(2).replace('.', ',') },
    v: { vv: String(validVotes) },
    carg: [{
      cd: '1',
      agr: scenario.candidates.map((candidate, index) => ({
        par: [{
          sg: candidate.sg,
          cand: [{ sqcand: candidate.sqcand, n: candidate.n, nmu: candidate.nmu, dvt: candidate.dvt, vap: String(counted[index]) }],
        }],
      })),
    }],
  };
}

function showSimulationStatus(scenario, pct, lap) {
  state.official = false;
  const done = pct >= 100;
  const fromTse = scenario.source === 'tse';
  setStatusBadge('sim', fromTse ? 'SIMULADO DO TSE' : 'SIMULAÇÃO');
  document.querySelector('#source-label').textContent = fromTse ? 'SIMULADO OFICIAL · TSE' : 'SIMULAÇÃO LOCAL';
  document.querySelector('#source-detail').textContent = fromTse
    ? `Ambiente de testes simulado2026 · aquecimento ${lap} · ${done ? 'reiniciando em instantes' : 'reprodução em loop'} · não é resultado`
    : `Candidatos e votos fictícios · aquecimento ${lap} · ${done ? 'reiniciando em instantes' : 'não são resultados do TSE'}`;
  document.querySelector('#last-update').innerHTML =
    `${fromTse ? 'SIMULADO' : 'SIMULAÇÃO'} <small>${done ? 'reiniciando' : 'aquecendo antes do ao vivo'}</small>`;
  document.querySelector('.lap-counter strong').innerHTML = `${String(lap).padStart(2, '0')} <i>/</i> ∞`;
}

async function startSimulation() {
  window.clearTimeout(state.simTimer);
  const run = ++state.simRun;
  state.source = 'sim';
  setStatusBadge('sim', 'CARREGANDO SIMULAÇÃO');
  let scenario;
  try {
    scenario = await loadTseSimScenario();
  } catch (error) {
    console.info('Simulado do TSE indisponível; usando simulação local.', error);
    scenario = localSimScenario();
  }
  // The user may have left the simulation while the file was loading.
  if (run !== state.simRun || state.source !== 'sim') return;
  // The simulation loops as a warm-up until the user stops it or the
  // official disclosure starts (lockRealtime stops it at 17h).
  let lap = 0;
  let pct = 0;
  const startLap = () => {
    lap += 1;
    pct = 0;
    if (lap > 1) reshuffleSimScenario(scenario);
    // Start every kart on the starting line.
    drivers = [];
    step();
  };
  const step = () => {
    applyResult(buildSimulatedResult(scenario, pct));
    showSimulationStatus(scenario, pct, lap);
    if (pct >= 100) {
      state.simTimer = window.setTimeout(startLap, SIM_LOOP_PAUSE_MS);
      return;
    }
    pct = nextSimPct(pct);
    state.simTimer = window.setTimeout(step, SIM_STEP_MS);
  };
  startLap();
}

function stopSimulation() {
  window.clearTimeout(state.simTimer);
  state.simRun += 1;
  state.source = 'live';
  if (state.lastOfficial) applyOfficialResult(state.lastOfficial);
  else showDemoResults();
}

async function pollTseResults() {
  try {
    const response = await fetch(state.resultUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Resultados ainda não publicados (${response.status}).`);
    const result = await response.json();
    if (result.f !== 'o') throw new Error('O arquivo consultado não está marcado como oficial.');
    if (!flattenCandidates(result).length) throw new Error('O arquivo EA20 ainda não tem votação para os candidatos.');
    state.lastOfficial = result;
    state.failures = 0;
    // During a simulation the official file is kept and shown when it ends.
    if (state.source === 'live') applyOfficialResult(result);
  } catch (error) {
    state.failures += 1;
    if (state.source !== 'live') {
      // Keep the simulation on screen; the retry below continues quietly.
    } else if (state.official) {
      setStatusBadge('stale', 'TSE SEM ATUALIZAÇÃO');
      document.querySelector('#source-label').textContent = 'ÚLTIMA LEITURA OFICIAL';
      document.querySelector('#source-detail').textContent = 'Conexão indisponível · mantendo os últimos dados do TSE';
    } else {
      displayOfficialStatus(false, state.realtime
        ? 'Tempo real ativo · aguardando arquivo do TSE · placar ilustrativo'
        : 'Aguardando publicação oficial · placar ilustrativo');
    }
    console.info('Aguardando arquivo oficial de resultados do TSE.', error);
  } finally {
    const backoff = state.realtime ? REALTIME_INTERVAL
      : Math.min(MAX_RETRY_INTERVAL, POLL_INTERVAL * 2 ** Math.min(state.failures, 5));
    schedulePoll(pollTseResults, backoff);
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.width = rect.width;
  state.height = rect.height;
  canvas.width = Math.round(rect.width * state.dpr);
  canvas.height = Math.round(rect.height * state.dpr);
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  // Keep the full-screen track below the top bar.
  state.topInset = state.immersive ? immersiveBar.offsetHeight : 0;
}

function ellipsePath(x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
}

function drawBackdrop(w, h) {
  ctx.clearRect(0, 0, w, h);
  const fade = ctx.createRadialGradient(w * .56, h * .61, h * .08, w * .56, h * .61, w * .62);
  fade.addColorStop(0, '#0a2352');
  fade.addColorStop(.58, '#071b42');
  fade.addColorStop(1, '#04132e');
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = .12;
  ctx.strokeStyle = '#dce2ea';
  ctx.lineWidth = 1;
  const gap = 28;
  const offset = (state.motion * .006) % gap;
  for (let x = -h; x < w + h; x += gap) {
    ctx.beginPath(); ctx.moveTo(x + offset, 0); ctx.lineTo(x - h + offset, h); ctx.stroke();
  }
  ctx.restore();
}

function trackGeometry(w, h) {
  const isMobile = w < 560;
  if (state.immersive) {
    const top = state.topInset;
    const free = Math.max(120, h - top);
    return {
      isMobile,
      rx: w * (isMobile ? .44 : .41),
      ry: free * (state.mode === 'top' ? .41 : .37),
      cx: w * .5,
      cy: top + free * .5,
      roadW: Math.max(39, Math.min(w, free) * .11),
    };
  }
  return {
    isMobile,
    rx: w * (isMobile ? .4 : .38),
    ry: h * (state.mode === 'top' ? .4 : .36),
    cx: w * .5,
    cy: h * .52,
    roadW: Math.max(39, Math.min(w, h) * .11),
  };
}

// Rotates a track-space point by the user-controlled track rotation.
function rotatePoint(x, y, cx, cy) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(state.rotation);
  const sin = Math.sin(state.rotation);
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// Eases the camera toward the leader (close chase view) or the full track.
function updateCamera(w, h) {
  const { cx, cy, rx, ry, roadW } = trackGeometry(w, h);
  let target = { x: w / 2, y: h / 2, zoom: 1 };
  if (state.mode === 'leader' && drivers.length) {
    const pose = kartPose(drivers[0], 0, cx, cy, rx, ry, roadW);
    // Look slightly ahead of the kart so the upcoming road stays in view.
    const ahead = roadW * .9;
    const focus = rotatePoint(
      pose.x + Math.sin(pose.heading) * ahead,
      pose.y - Math.cos(pose.heading) * ahead, cx, cy);
    target = { x: focus.x, y: focus.y, zoom: LEADER_ZOOM };
  }
  const cam = state.camera;
  const ease = cam.ready ? .08 : 1;
  cam.x += (target.x - cam.x) * ease;
  cam.y += (target.y - cam.y) * ease;
  cam.zoom += (target.zoom - cam.zoom) * ease;
  cam.ready = true;
}

// Maps a world point to the screen through the camera.
function toScreen(x, y, w, h) {
  const cam = state.camera;
  return { x: w / 2 + (x - cam.x) * cam.zoom, y: h / 2 + (y - cam.y) * cam.zoom };
}

function drawTrack(w, h, time) {
  const { cx, cy, rx, ry, roadW } = trackGeometry(w, h);
  const rotation = state.rotation;
  const cam = state.camera;

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.translate(-cx, -cy);

  ctx.save();
  ctx.shadowColor = '#020a1a';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 16;
  ellipsePath(cx, cy, rx + 7, ry + 7);
  ctx.fillStyle = '#030f26';
  ctx.fill();
  ctx.restore();

  ellipsePath(cx, cy, rx, ry);
  const asphalt = ctx.createLinearGradient(cx, cy - ry, cx, cy + ry);
  asphalt.addColorStop(0, '#46546b'); asphalt.addColorStop(.48, '#2e3a50'); asphalt.addColorStop(1, '#222c3f');
  ctx.fillStyle = asphalt;
  ctx.fill();
  ctx.strokeStyle = '#f5f7fa'; ctx.lineWidth = 4; ctx.stroke();

  ellipsePath(cx, cy, rx - roadW, Math.max(10, ry - roadW * .73));
  ctx.fillStyle = '#00702a'; ctx.fill();
  ctx.strokeStyle = '#dce2ea'; ctx.lineWidth = 2; ctx.stroke();

  ctx.save();
  ctx.setLineDash([12, 13]);
  ctx.lineDashOffset = -state.motion * .012;
  ctx.strokeStyle = 'rgba(245,247,250,.55)';
  ctx.lineWidth = 2;
  ellipsePath(cx, cy, rx - roadW * .51, ry - roadW * .37);
  ctx.stroke();
  ctx.restore();

  for (let i = 0; i < 36; i++) {
    const angle = i * Math.PI * 2 / 36;
    const x = cx + Math.cos(angle) * (rx - roadW * .52);
    const y = cy + Math.sin(angle) * (ry - roadW * .38);
    ctx.beginPath(); ctx.arc(x, y, 1.25, 0, Math.PI * 2);
    ctx.fillStyle = i % 3 === 0 ? 'rgba(245,247,250,.32)' : 'rgba(245,247,250,.14)'; ctx.fill();
  }

  // Start and finish markings: karts start at the top (0% of the lap), so the
  // checkered line crosses the road there, clipped to the asphalt ring.
  const innerRy = Math.max(10, ry - roadW * .73);
  const rows = 6;
  const cell = (ry - innerRy) / rows;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.ellipse(cx, cy, rx - roadW, innerRy, 0, 0, Math.PI * 2);
  ctx.clip('evenodd');
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 2; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#f5f7fa' : '#04132e';
      ctx.fillRect(cx - cell + c * cell, cy - ry + r * cell, cell + .5, cell + .5);
    }
  }
  ctx.restore();

  // Infield details.
  ctx.fillStyle = 'rgba(4,19,46,.38)';
  ctx.beginPath(); ctx.ellipse(cx, cy + 1, (rx - roadW) * .65, (ry - roadW * .73) * .62, 0, 0, Math.PI * 2); ctx.fill();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(245,247,250,.6)'; ctx.font = '500 9px "DM Mono", monospace';
  ctx.fillText('CORRIDA DA APURAÇÃO', cx, cy - 12);
  ctx.fillStyle = 'rgba(255,214,0,.95)'; ctx.font = '700 24px "Barlow Condensed", Impact, sans-serif';
  ctx.fillText(`${formatVote(state.sectionPct)}%`, cx, cy + 12);
  ctx.fillStyle = 'rgba(220,226,234,.5)'; ctx.font = '500 7px "DM Mono", monospace';
  ctx.fillText('SEÇÕES TOTALIZADAS', cx, cy + 29);

  // Corner boards.
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI * (i * .5 + .25);
    const x = cx + Math.cos(angle) * (rx + 12);
    const y = cy + Math.sin(angle) * (ry + 12);
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle + Math.PI / 2);
    ctx.fillStyle = '#009b3a'; ctx.fillRect(-12, -2, 24, 4);
    ctx.fillStyle = '#ffd600'; ctx.fillRect(-12, -2, 5, 4);
    ctx.restore();
  }

  drivers.slice(0, 12).forEach((driver, index) => {
    // Vote share determines the kart's point on the circuit; the position
    // changes only when a new official result file is received.
    const pose = kartPose(driver, index, cx, cy, rx, ry, roadW);
    drawKart(pose.x, pose.y, pose.heading, driver, index, time);
  });

  ctx.restore();
  drawTrackLabels(w, h);
}

// Places a kart between the inner and outer track edges at the same ellipse
// parameter, so it stays on its lane and faces along the elliptical tangent.
function kartPose(driver, index, cx, cy, rx, ry, roadW) {
  const angle = -Math.PI / 2 + (driver.currentVotes / 100) * Math.PI * 2;
  const innerRx = rx - roadW;
  const innerRy = Math.max(10, ry - roadW * .73);
  // Alternate karts between the outer and inner half of the road.
  const lane = index % 2 ? .34 : .66;
  const a = innerRx + (rx - innerRx) * lane;
  const b = innerRy + (ry - innerRy) * lane;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  // Kart artwork points toward -y; rotate it onto the clockwise tangent.
  const heading = Math.atan2(-a * sin, -b * cos);
  return { angle, x: cx + cos * a, y: cy + sin * b, heading };
}

function drawTire(x, y, w, h, rotation) {
  ctx.fillStyle = '#0d1310';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.12)';
  const treadLength = h - 2;
  const phase = ((rotation % 2.5) + 2.5) % 2.5;
  for (let stripe = 0; stripe < 4; stripe += 1) {
    const offset = (stripe * 2.5 + phase) % treadLength;
    ctx.fillRect(x + 1, y + 1 + offset, w - 2, .8);
  }
}

// Top-down racing kart; the artwork points toward -y.
function drawKart(x, y, angle, driver, index, time) {
  const maxScale = state.immersive ? 2.2 : 1.5;
  const scale = Math.max(.78, Math.min(maxScale, Math.min(state.width, state.height) / 460));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  const glow = .18 + Math.sin(time * .003 + index * 1.4) * .045;
  const tireRotation = state.motion * .7;

  // Ground shadow.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 7; ctx.shadowOffsetY = 3;
  ctx.fillStyle = 'rgba(0,0,0,.3)';
  ctx.beginPath(); ctx.ellipse(1, 1, 13, 18, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Axles and tires.
  ctx.fillStyle = '#5b6660';
  ctx.fillRect(-11, -11.5, 22, 2); ctx.fillRect(-13, 10, 26, 2);
  drawTire(-14, -16, 5, 10, tireRotation); drawTire(9, -16, 5, 10, tireRotation);
  drawTire(-16, 5, 6, 12, tireRotation); drawTire(10, 5, 6, 12, tireRotation);

  // Front wing and rear bumper.
  ctx.fillStyle = '#1b2520';
  ctx.beginPath(); ctx.roundRect(-12, 16, 24, 3.5, 1.5); ctx.fill();
  ctx.fillStyle = driver.color;
  ctx.beginPath(); ctx.roundRect(-11, -22, 22, 3.5, 1.5); ctx.fill();

  // Colored bodywork: nose cone flowing into the side pods.
  ctx.shadowColor = driver.glow; ctx.shadowBlur = 8 + glow * 14;
  ctx.beginPath();
  ctx.moveTo(-3, -20); ctx.lineTo(3, -20);
  ctx.quadraticCurveTo(6, -12, 6, -5);
  ctx.lineTo(10, -2); ctx.quadraticCurveTo(11, 6, 9, 13);
  ctx.lineTo(-9, 13); ctx.quadraticCurveTo(-11, 6, -10, -2);
  ctx.lineTo(-6, -5); ctx.quadraticCurveTo(-6, -12, -3, -20);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;

  // Shading stripe down the left side for volume.
  ctx.fillStyle = 'rgba(0,0,0,.2)';
  ctx.beginPath(); ctx.moveTo(-6, -5); ctx.lineTo(-10, -2);
  ctx.quadraticCurveTo(-11, 6, -9, 13); ctx.lineTo(-6, 13); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.28)';
  ctx.fillRect(-.6, -19, 1.2, 9);

  // Race number on the nose.
  ctx.fillStyle = '#0e1712';
  ctx.font = '700 6px "Barlow Condensed", Impact, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(index + 1), 0, -9.5);

  // Cockpit, steering wheel, driver helmet with visor, rear engine.
  ctx.fillStyle = '#111a15';
  ctx.beginPath(); ctx.ellipse(0, 3, 5.5, 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c9d3cb'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(0, -1, 3, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
  ctx.fillStyle = '#eef3ec';
  ctx.beginPath(); ctx.arc(0, 4, 4.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = driver.color;
  ctx.fillRect(-.9, 0, 1.8, 8);
  ctx.fillStyle = '#16212a';
  ctx.beginPath(); ctx.ellipse(0, 1.6, 3, 1.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2c3732';
  ctx.beginPath(); ctx.roundRect(-4, 12, 8, 4, 1); ctx.fill();
  ctx.fillStyle = '#8c968f';
  ctx.beginPath(); ctx.arc(2.2, 16.5, 1.1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Shortens text with an ellipsis so it fits the badge at the current font.
function fitText(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end)}…`;
}

function drawTrackLabels(w, h) {
  const { isMobile, cx, cy, rx, ry, roadW } = trackGeometry(w, h);
  const zoom = state.camera.zoom;
  // In immersive mode karts grow with the screen, and their badges follow.
  const k = Math.max(1, Math.min(state.immersive ? 1.9 : 1.35, Math.min(w, h) / 460));
  drivers.slice(0, 12).forEach((driver, index) => {
    const pose = kartPose(driver, index, cx, cy, rx, ry, roadW);
    const angle = pose.angle;
    const world = rotatePoint(pose.x, pose.y, cx, cy);
    // Keep the badge clear of the kart, which grows with the camera zoom.
    const { x, y } = toScreen(world.x, world.y, w, h);
    const gapX = 9 * zoom * k;
    const gapY = 5 * zoom * k;
    const badgeW = (isMobile ? 62 : 82) * k;
    const badgeH = (isMobile ? 24 : 28) * k;
    let badgeX = x + (Math.cos(angle) > .1 ? gapX : -badgeW - gapX);
    // Flip the badge to the other side of the kart rather than letting it leave the screen.
    if (badgeX + badgeW > w - 8) badgeX = x - badgeW - gapX;
    else if (badgeX < 8) badgeX = x + gapX;
    const badgeY = y + (Math.sin(angle) > .35 ? gapY : -badgeH - gapY);
    ctx.save();
    ctx.fillStyle = 'rgba(4,19,46,.92)';
    ctx.strokeStyle = driver.color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3); ctx.fill(); ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left'; ctx.fillStyle = '#dce2ea';
    ctx.font = `600 ${(isMobile ? 7 : 8) * k}px "DM Mono", monospace`;
    const outcome = OUTCOME_SHORT[driver.outcome];
    const nameLine = isMobile ? (outcome || `P${index + 1}`) : (outcome ? `${outcome} ${driver.name.toUpperCase()}` : driver.name.toUpperCase());
    if (outcome) ctx.fillStyle = '#ffd600';
    ctx.fillText(fitText(nameLine, badgeW - 12 * k), badgeX + 6 * k, badgeY + badgeH * .37);
    ctx.fillStyle = driver.color;
    const percent = `${formatVote(driver.votes)}%`;
    const percentFont = (isMobile ? 9 : 11) * k;
    ctx.font = `700 ${percentFont}px "Barlow Condensed", Impact, sans-serif`;
    ctx.fillText(percent, badgeX + 6 * k, badgeY + badgeH * .73);
    if (Number.isFinite(driver.voteCount)) {
      const count = new Intl.NumberFormat('pt-BR').format(driver.voteCount);
      const countX = badgeX + 9 * k + ctx.measureText(percent).width;
      const countMaxWidth = Math.max(8 * k, badgeW - (countX - badgeX) - 5 * k);
      const countFont = Math.max(4 * k, Math.min((isMobile ? 5.5 : 6.5) * k, countMaxWidth / Math.max(1, count.length * .62)));
      ctx.fillStyle = '#dce2ea';
      ctx.font = `500 ${countFont}px "DM Mono", monospace`;
      ctx.fillText(count, countX, badgeY + badgeH * .73, countMaxWidth);
    }
    ctx.restore();
  });
}

function frame(now) {
  const w = state.width;
  const h = state.height;
  if (w && h) {
    let gap = 0;
    drivers.forEach((driver) => {
      const remaining = driver.votes - driver.currentVotes;
      gap = Math.max(gap, Math.abs(remaining));
      driver.currentVotes = Math.abs(remaining) < .015 ? driver.votes : driver.currentVotes + remaining * .055;
    });
    // The track scrolls only while the karts are moving, slowing as they settle.
    const dt = Math.min(100, now - (state.lastFrame || now));
    state.lastFrame = now;
    state.motion += dt * Math.min(1, gap / .4);
    drawBackdrop(w, h);
    updateCamera(w, h);
    drawTrack(w, h, now - state.started);
  }
  requestAnimationFrame(frame);
}

function setCamera(mode) {
  state.mode = mode;
  const labels = { track: 'CÂMERA PANORÂMICA', top: 'CÂMERA AÉREA', leader: 'CÂMERA DO LÍDER' };
  cameraName.textContent = labels[mode];
  cameraButtons.forEach((button) => {
    const active = button.dataset.camera === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

cameraButtons.forEach((button) => button.addEventListener('click', () => setCamera(button.dataset.camera)));
liveButton.addEventListener('click', startRealtimeManually);
barLive.addEventListener('click', startRealtimeManually);
barListToggle.addEventListener('click', () => {
  const show = canvasWrap.classList.toggle('hide-list') === false;
  barListToggle.classList.toggle('active', show);
  barListToggle.setAttribute('aria-pressed', String(show));
  resizeCanvas();
});
document.querySelector('#bar-exit').addEventListener('click', toggleFullscreen);
new ResizeObserver(resizeCanvas).observe(immersiveBar);

// Mirrors the data-source badge and counted sections into the top bar.
function updateBarStatus() {
  const source = document.querySelector('.demo-tag').textContent.replace(/[◉●▶]/g, '').trim();
  const sections = document.querySelector('#sections-percent').textContent;
  document.querySelector('#bar-status').textContent = `${source} · ${sections} SEÇÕES`;
}
const statusObserver = new MutationObserver(updateBarStatus);
statusObserver.observe(document.querySelector('.demo-tag'), { childList: true, characterData: true, subtree: true });
statusObserver.observe(document.querySelector('#sections-percent'), { childList: true, characterData: true, subtree: true });
updateBarStatus();
window.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    state.rotation += event.key === 'ArrowLeft' ? -.055 : .055;
  }
  if (event.key.toLowerCase() === 'f') toggleFullscreen();
  if (event.key === 'Escape' && !finalScreen.hidden) showFinalScreen(false);
  if (event.key === 'Escape' && state.immersive && !document.fullscreenElement) setImmersive(false);
});

function setImmersive(on) {
  state.immersive = on;
  canvasWrap.classList.toggle('is-immersive', on);
  document.body.classList.toggle('has-immersive', on);
  fullscreenButton.setAttribute('aria-pressed', String(on));
  fullscreenButton.innerHTML = on ? '✕ <span>SAIR</span>' : '⛶ <span>TELA CHEIA</span>';
  fullscreenButton.setAttribute('aria-label', on ? 'Sair da tela cheia' : 'Mostrar só a pista em tela cheia');
  state.camera.ready = false;
  resizeCanvas();
}

// Shows only the track. The fixed overlay also works where the Fullscreen API
// is unavailable (iPhone, embedded previews).
async function toggleFullscreen() {
  const on = !state.immersive;
  setImmersive(on);
  try {
    if (on && !document.fullscreenElement) await canvasWrap.requestFullscreen();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch { /* The fixed overlay already fills the window. */ }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.immersive) setImmersive(false);
});
fullscreenButton.addEventListener('click', toggleFullscreen);

buildStandings();
new ResizeObserver(resizeCanvas).observe(canvas);
resizeCanvas();
requestAnimationFrame(frame);
state.roundDates = { ...DEFAULT_ROUND_DATES };
scheduleRealtimeLock();
updateCountdown();
window.setInterval(updateCountdown, 1000);
if (!state.locked) {
  connectToTse();
  // Until the disclosure starts, a looping simulation warms up the track.
  startSimulation();
}
