// Results by state: every office of the 2026 general election, read from the
// official TSE files (EA20, one file per state and office).
const TSE_BASE = 'https://resultados.tse.jus.br';
const CONFIG_URL = `${TSE_BASE}/oficial/comum/config/ele-c.json`;
const CYCLE = 'ele2026';
const REFRESH_INTERVAL = 60_000;
const PAGE_SIZE = 100;
// A file read less than this long ago is shown without asking the TSE again.
const FRESH_MS = 30_000;
// Rows whose photos load first; the rest wait until the network is free.
const PRIORITY_PHOTOS = 10;
const STORAGE_KEY = 'estados:last-result';
// Used until the TSE configuration loads (or if it cannot be reached).
const DEFAULT_ELECTIONS = { 1: { 1: '6257', 3: '6259', 5: '6259', 6: '6259', 7: '6259', 8: '6259' } };
const DEFAULT_TEMPLATES = {
  u: '<base>/<ambiente>/<ciclo>/<cd_eleicao>/dados/<uf>',
  ft: '<base>/<ambiente>/<ciclo>/<cd_eleicao>/fotos/<uf>',
};

const UFS = [
  ['br', 'Brasil (nacional)'], ['ac', 'Acre'], ['al', 'Alagoas'], ['ap', 'Amapá'], ['am', 'Amazonas'],
  ['ba', 'Bahia'], ['ce', 'Ceará'], ['df', 'Distrito Federal'], ['es', 'Espírito Santo'], ['go', 'Goiás'],
  ['ma', 'Maranhão'], ['mt', 'Mato Grosso'], ['ms', 'Mato Grosso do Sul'], ['mg', 'Minas Gerais'],
  ['pa', 'Pará'], ['pb', 'Paraíba'], ['pr', 'Paraná'], ['pe', 'Pernambuco'], ['pi', 'Piauí'],
  ['rj', 'Rio de Janeiro'], ['rn', 'Rio Grande do Norte'], ['rs', 'Rio Grande do Sul'], ['ro', 'Rondônia'],
  ['rr', 'Roraima'], ['sc', 'Santa Catarina'], ['sp', 'São Paulo'], ['se', 'Sergipe'], ['to', 'Tocantins'],
];
const OFFICES = [
  { cd: '1', label: 'Presidente' },
  { cd: '3', label: 'Governador' },
  { cd: '5', label: 'Senador' },
  { cd: '6', label: 'Deputado Federal' },
  { cd: '7', label: 'Deputado Estadual' },
  { cd: '8', label: 'Deputado Distrital' },
];

const state = {
  elections: DEFAULT_ELECTIONS, templates: { ...DEFAULT_TEMPLATES },
  uf: 'sp', office: '1', round: '1',
  query: '', electedOnly: false, limit: PAGE_SIZE,
  result: null, candidates: [], projected: false, request: 0, timer: 0,
};

const $ = (selector) => document.querySelector(selector);
// Files already read (url → { result, fetchedAt }) and requests in flight, so
// switching tabs back and forth never downloads the same file twice at once.
const resultCache = new Map();
const pendingRequests = new Map();
const numberFormat = new Intl.NumberFormat('pt-BR');

function parseTseNumber(value) {
  const number = Number.parseFloat(String(value ?? '0').replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

const formatPct = (value) => `${parseTseNumber(value).toFixed(2).replace('.', ',')}%`;
const normalize = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The DF elects district deputies instead of state deputies; the national
// scope only has the presidential race.
function officesFor(uf, round) {
  const available = state.elections[round] || {};
  return OFFICES.filter(({ cd }) => {
    if (!available[cd]) return false;
    if (uf === 'br') return cd === '1';
    if (cd === '7') return uf !== 'df';
    if (cd === '8') return uf === 'df';
    return true;
  });
}

// Maps round → office code → election code for the 2026 cycle.
function readElections(config) {
  const elections = {};
  for (const cycle of config.pl || []) {
    if (cycle.c !== CYCLE) continue;
    for (const election of cycle.e || []) {
      const round = String(election.t);
      for (const scope of election.abr || []) {
        for (const office of scope.cp || []) {
          const cd = String(Number(office.cd));
          if (!OFFICES.some((item) => item.cd === cd)) continue;
          elections[round] ||= {};
          elections[round][cd] = String(election.cd);
        }
      }
    }
  }
  return elections;
}

function fillTemplate(template, uf, electionCode) {
  return template
    .replaceAll('<base>', TSE_BASE)
    .replaceAll('<ambiente>', 'oficial')
    .replaceAll('<ciclo>', CYCLE)
    .replaceAll('<cd_eleicao>', electionCode)
    .replaceAll('<uf>', uf);
}

function resultUrl(uf = state.uf, office = state.office, round = state.round) {
  const code = state.elections[round][office];
  const file = `${uf}-c${office.padStart(4, '0')}-e${code.padStart(6, '0')}-u.json`;
  return `${fillTemplate(state.templates.u, uf, code)}/${file}`;
}

// Presidential photos live in the national folder.
function photoUrl(sqcand) {
  const code = state.elections[state.round][state.office];
  const uf = state.office === '1' ? 'br' : state.uf;
  return `${fillTemplate(state.templates.ft, uf, code)}/${sqcand}.jpeg`;
}

function candidateOutcome(candidate) {
  const status = normalize(candidate.st);
  if (/2[ºo°]?\s*turno|segundo turno/.test(status)) return 'runoff';
  if (candidate.e === 's' || (status.includes('eleito') && !status.includes('nao'))) return 'elected';
  return '';
}

function flattenCandidates(result) {
  const office = (result.carg || []).find((item) => String(Number(item.cd)) === state.office) || result.carg?.[0];
  if (!office) return [];
  const list = (office.agr || []).flatMap((group) =>
    (group.par || []).flatMap((party) =>
      (party.cand || []).map((candidate) => ({
        id: String(candidate.sqcand || candidate.n),
        number: candidate.n,
        name: candidate.nmu || candidate.nm || 'Candidatura',
        fullName: candidate.nm || '',
        party: party.sg || group.com || '',
        group: group.tp === 'c' ? group.nm : '',
        seatGroup: group,
        votes: parseTseNumber(candidate.vap),
        pct: candidate.pvap,
        status: candidate.st || '',
        validity: candidate.dvt || '',
        outcome: candidateOutcome(candidate),
        running: (candidate.vs || []).map((mate) => ({ type: mate.tp, name: mate.nmu || mate.nm, party: mate.sgp })),
      }))));
  list.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'pt-BR'));
  list.forEach((candidate, index) => { candidate.rank = index + 1; });
  applyProjection(result, office, list);
  return list;
}

const isValidCandidate = (candidate) => normalize(candidate.validity).startsWith('valido');

// While the TSE has not marked anyone, projects the outcome from the votes
// counted so far. Proportional offices use the seats the TSE already assigns
// to each party or federation (`vag`) and fill them with its most voted
// candidates; majoritarian offices follow the majority and plurality rules.
function applyProjection(result, office, list) {
  state.projected = false;
  if (list.some((candidate) => candidate.outcome || candidate.status)) return;
  const valid = list.filter(isValidCandidate);
  if (!valid.length || !valid[0].votes) return;
  const mark = (candidates, outcome) => candidates.forEach((candidate) => { candidate.projection = outcome; });
  if (['6', '7', '8'].includes(state.office)) {
    const groups = new Map();
    valid.forEach((candidate) => {
      if (!groups.has(candidate.seatGroup)) groups.set(candidate.seatGroup, []);
      groups.get(candidate.seatGroup).push(candidate);
    });
    groups.forEach((candidates, group) => mark(candidates.slice(0, parseTseNumber(group.vag)), 'elected'));
  } else if (state.office === '5') {
    mark(valid.slice(0, parseTseNumber(office.nv) || 1), 'elected');
  } else if (state.office === '3' || (state.office === '1' && state.uf === 'br')) {
    const validTotal = valid.reduce((total, candidate) => total + candidate.votes, 0);
    if (String(result.t) === '2' || valid[0].votes / validTotal > .5) mark(valid.slice(0, 1), 'elected');
    else mark(valid.slice(0, 2), 'runoff');
  } else {
    return;
  }
  state.projected = list.some((candidate) => candidate.projection);
}

function setStatus(kind, text) {
  $('#status-tag').dataset.state = kind;
  $('#status-text').textContent = text;
}

function showMessage(text, kind = 'info') {
  const message = $('#message');
  message.hidden = !text;
  message.dataset.kind = kind;
  message.textContent = text || '';
}

function officeLabel() {
  return OFFICES.find((office) => office.cd === state.office)?.label || '';
}

function ufLabel() {
  return UFS.find(([uf]) => uf === state.uf)?.[1] || state.uf.toUpperCase();
}

function renderTabs() {
  const tabs = $('#office-tabs');
  const available = officesFor(state.uf, state.round).map((office) => office.cd);
  tabs.replaceChildren(...OFFICES
    .filter(({ cd }) => (state.uf === 'df' ? cd !== '7' : cd !== '8'))
    .map(({ cd, label }) => {
      const button = element('button', 'office-tab', label);
      button.type = 'button';
      button.disabled = !available.includes(cd);
      button.setAttribute('aria-pressed', String(cd === state.office));
      button.addEventListener('click', () => {
        state.office = cd;
        selectionChanged();
      });
      return button;
    }));
}

function summaryCard(label, value, detail, progress) {
  const card = element('div', 'summary-card');
  card.append(element('span', 'field-label', label), element('strong', '', value));
  if (detail) card.append(element('small', '', detail));
  if (progress !== undefined) {
    const bar = element('div', 'summary-progress');
    const fill = element('span');
    fill.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    bar.append(fill);
    card.append(bar);
  }
  return card;
}

function renderSummary() {
  const summary = $('#summary');
  const result = state.result;
  if (!result) {
    summary.replaceChildren();
    return;
  }
  const office = result.carg?.[0] || {};
  const votes = result.v || {};
  const sections = parseTseNumber(result.s?.pst);
  const cards = [
    summaryCard('SEÇÕES TOTALIZADAS', formatPct(result.s?.pst), result.tf === 's' ? 'Totalização finalizada' : `${numberFormat.format(parseTseNumber(result.s?.st))} de ${numberFormat.format(parseTseNumber(result.s?.ts))}`, sections),
    summaryCard('VOTOS VÁLIDOS', numberFormat.format(parseTseNumber(votes.vv)), `${formatPct(votes.pvv)} dos votos`),
    summaryCard('BRANCOS', numberFormat.format(parseTseNumber(votes.vb)), formatPct(votes.pvb)),
    summaryCard('NULOS', numberFormat.format(parseTseNumber(votes.tvn ?? votes.vn)), formatPct(votes.ptvn ?? votes.pvn)),
    summaryCard('ABSTENÇÃO', formatPct(result.e?.pa), `${numberFormat.format(parseTseNumber(result.e?.a))} eleitores`),
  ];
  if (parseTseNumber(office.nv) > 1) cards.push(summaryCard('VAGAS', office.nv, office.qe ? `Quociente eleitoral: ${numberFormat.format(parseTseNumber(office.qe))}` : ''));
  summary.replaceChildren(...cards);
}

function runningMatesText(running) {
  if (!running.length) return '';
  const vice = running.filter((mate) => mate.type === 'v').map((mate) => mate.name);
  const substitutes = running.filter((mate) => mate.type !== 'v').map((mate) => mate.name);
  return [vice.length ? `Vice: ${vice.join(', ')}` : '', substitutes.length ? `Suplentes: ${substitutes.join(', ')}` : '']
    .filter(Boolean).join(' · ');
}

function candidateRow(candidate, topVotes, index) {
  const outcome = candidate.outcome || candidate.projection;
  const row = element('li', `candidate${outcome ? ` is-${outcome}` : ''}${candidate.projection ? ' is-projected' : ''}`);
  row.append(element('span', 'candidate-rank', String(candidate.rank).padStart(2, '0')));

  // Lazy images only load while in the document, so the photo goes in right
  // away over the initial and is dropped when the TSE has no file for it.
  const photo = element('span', 'candidate-photo');
  photo.append(element('span', 'candidate-initial', candidate.name.trim().charAt(0)));
  const image = new Image();
  image.loading = 'lazy';
  image.decoding = 'async';
  image.fetchPriority = index < PRIORITY_PHOTOS ? 'high' : 'low';
  image.width = 52;
  image.height = 52;
  image.alt = '';
  image.addEventListener('load', () => image.classList.add('is-loaded'), { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = photoUrl(candidate.id);
  photo.append(image);
  row.append(photo);

  const info = element('div', 'candidate-info');
  const name = element('div', 'candidate-name', candidate.name);
  name.append(element('span', 'candidate-number', candidate.number));
  if (candidate.outcome === 'elected') name.append(element('span', 'tag tag-elected', candidate.status.toUpperCase() || 'ELEITO'));
  else if (candidate.outcome === 'runoff') name.append(element('span', 'tag tag-runoff', '2º TURNO'));
  else if (candidate.projection === 'elected') name.append(element('span', 'tag tag-elected tag-projected', 'PROJEÇÃO: ELEITO'));
  else if (candidate.projection === 'runoff') name.append(element('span', 'tag tag-runoff tag-projected', 'PROJEÇÃO: 2º TURNO'));
  else if (candidate.status) name.append(element('span', 'tag', candidate.status.toUpperCase()));
  if (candidate.validity && !normalize(candidate.validity).startsWith('valido')) {
    name.append(element('span', 'tag tag-invalid', candidate.validity.toUpperCase()));
  }
  info.append(name, element('div', 'candidate-detail', [candidate.party, candidate.group, candidate.fullName].filter(Boolean).join(' · ')));
  const mates = runningMatesText(candidate.running);
  if (mates) info.append(element('div', 'candidate-extra', mates));
  row.append(info);

  const votes = element('div', 'candidate-votes');
  votes.append(element('strong', '', formatPct(candidate.pct)), element('small', '', `${numberFormat.format(candidate.votes)} votos`));
  row.append(votes);

  const bar = element('span', 'candidate-bar');
  const fill = element('span');
  fill.style.width = `${topVotes ? candidate.votes / topVotes * 100 : 0}%`;
  bar.append(fill);
  row.append(bar);
  return row;
}

function renderCandidates() {
  const query = normalize(state.query.trim());
  const filtered = state.candidates.filter((candidate) => {
    if (state.electedOnly && !candidate.outcome && !candidate.projection) return false;
    if (!query) return true;
    return [candidate.name, candidate.fullName, candidate.number, candidate.party, candidate.group]
      .some((field) => normalize(field).includes(query));
  });
  const topVotes = state.candidates[0]?.votes || 0;
  const shown = filtered.slice(0, state.limit);
  $('#candidates').replaceChildren(...shown.map((candidate, index) => candidateRow(candidate, topVotes, index)));
  $('#results-count').textContent = state.result
    ? `${numberFormat.format(filtered.length)} de ${numberFormat.format(state.candidates.length)} candidatos`
    : '';
  const more = $('#more-button');
  more.hidden = filtered.length <= shown.length;
  more.textContent = `Mostrar mais (${numberFormat.format(filtered.length - shown.length)} restantes)`;
  if (state.result && !filtered.length) {
    showMessage(state.candidates.length ? 'Nenhum candidato encontrado com esses filtros.' : 'O TSE ainda não divulgou votos para este cargo.');
  } else if (state.result) {
    showMessage('');
  }
  const note = $('#projection-note');
  note.hidden = !state.projected;
  note.textContent = state.projected
    ? `Projeção com ${formatPct(state.result.s?.pst)} das seções totalizadas, calculada com os votos apurados até agora. Pode mudar até o fim da apuração; vale o resultado oficial do TSE.`
    : '';
}

function renderTitle() {
  $('#results-title').textContent = `${officeLabel()} · ${ufLabel()}`;
  document.title = `${officeLabel()} em ${ufLabel()} — Corrida da Apuração`;
}

function readStoredResult(url) {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null');
    return stored?.url === url ? stored : null;
  } catch {
    return null;
  }
}

function storeResult(url, entry) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ url, ...entry }));
  } catch {
    // Storage full or blocked: the in-memory cache still works.
  }
}

function cachedResult(url) {
  if (!resultCache.has(url)) {
    const stored = readStoredResult(url);
    if (stored) resultCache.set(url, { result: stored.result, fetchedAt: stored.fetchedAt });
  }
  return resultCache.get(url);
}

function fetchResult(url) {
  if (pendingRequests.has(url)) return pendingRequests.get(url);
  const request = (async () => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (response.status === 403 || response.status === 404) throw Object.assign(new Error('not-published'), { missing: true });
    if (!response.ok) throw new Error(`TSE respondeu ${response.status}`);
    const entry = { result: await response.json(), fetchedAt: Date.now() };
    resultCache.set(url, entry);
    return entry;
  })().finally(() => pendingRequests.delete(url));
  pendingRequests.set(url, request);
  return request;
}

function showSkeleton() {
  $('#candidates').replaceChildren(...Array.from({ length: 8 }, () => {
    const row = element('li', 'candidate skeleton');
    row.setAttribute('aria-hidden', 'true');
    row.append(element('span', 'candidate-rank'), element('span', 'candidate-photo'), element('div', 'candidate-info'), element('div', 'candidate-votes'));
    return row;
  }));
}

function showResult(result) {
  // A refresh that brings the same TSE file keeps the list as it is.
  const unchanged = state.result && result.idg && state.result.idg === result.idg && state.result.cdabr === result.cdabr;
  state.result = result;
  const time = `${result.dg || ''} ${result.hg || ''}`.trim();
  setStatus('official', `DADOS OFICIAIS DO TSE${time ? ` · ${time}` : ''}`);
  if (unchanged) return;
  state.candidates = flattenCandidates(result);
  renderSummary();
  renderCandidates();
}

function scheduleRefresh(delay = REFRESH_INTERVAL) {
  window.clearTimeout(state.timer);
  if (state.result?.tf === 's') return;
  state.timer = window.setTimeout(() => loadResults({ quiet: true }), delay);
}

async function loadResults({ quiet = false } = {}) {
  window.clearTimeout(state.timer);
  const request = ++state.request;
  const url = resultUrl();
  const cached = cachedResult(url);
  if (!quiet) {
    state.result = null;
    state.candidates = [];
    $('#more-button').hidden = true;
    $('#results-count').textContent = '';
    $('#projection-note').hidden = true;
    if (cached) {
      showResult(cached.result);
    } else {
      renderSummary();
      showMessage('');
      showSkeleton();
    }
  }
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (!quiet && age < FRESH_MS) {
    scheduleRefresh(REFRESH_INTERVAL - age);
    prefetchOtherOffices();
    return;
  }
  try {
    const entry = await fetchResult(url);
    storeResult(url, entry);
    if (request !== state.request) return;
    showResult(entry.result);
    scheduleRefresh();
    prefetchOtherOffices();
  } catch (error) {
    if (request !== state.request) return;
    console.info('Resultado do TSE indisponível.', error);
    if (state.result) {
      setStatus('error', 'TSE SEM ATUALIZAÇÃO · MOSTRANDO A ÚLTIMA LEITURA');
    } else if (error.missing) {
      $('#candidates').replaceChildren();
      setStatus('loading', 'AGUARDANDO PUBLICAÇÃO DO TSE');
      showMessage('Os resultados deste cargo ainda não foram publicados pelo TSE. A página tenta de novo automaticamente.');
    } else {
      $('#candidates').replaceChildren();
      setStatus('error', 'SEM CONEXÃO COM O TSE');
      showMessage('Não foi possível conectar ao TSE agora. Tentaremos de novo em instantes.', 'error');
    }
    state.timer = window.setTimeout(() => loadResults({ quiet: Boolean(state.result) }), REFRESH_INTERVAL);
  }
}

// Downloads the other offices of the selected state in the background, one
// at a time, so switching tabs shows them right away.
let prefetchRun = 0;
async function prefetchOtherOffices() {
  const run = ++prefetchRun;
  const { uf, round } = state;
  const urls = officesFor(uf, round)
    .filter(({ cd }) => cd !== state.office)
    .map(({ cd }) => resultUrl(uf, cd, round));
  for (const url of urls) {
    await new Promise((resolve) => (window.requestIdleCallback || window.setTimeout)(resolve, { timeout: 1000 }));
    if (run !== prefetchRun) return;
    const cached = resultCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < FRESH_MS) continue;
    try {
      await fetchResult(url);
    } catch {
      // Not published yet; the tab tries again when it is opened.
    }
  }
}

function saveSelection() {
  const params = new URLSearchParams({ uf: state.uf, cargo: state.office });
  if (state.round !== '1') params.set('turno', state.round);
  history.replaceState(null, '', `?${params}`);
}

function selectionChanged() {
  // State and district deputies are the same race under another name.
  if (state.uf === 'df' && state.office === '7') state.office = '8';
  if (state.uf !== 'df' && state.office === '8') state.office = '7';
  const offices = officesFor(state.uf, state.round);
  if (!offices.some((office) => office.cd === state.office)) state.office = offices[0]?.cd || '1';
  state.limit = PAGE_SIZE;
  saveSelection();
  renderTabs();
  renderTitle();
  if (!officesFor(state.uf, state.round).length) {
    showMessage('Não há eleição configurada para esta seleção.');
    return;
  }
  loadResults();
}

function renderRoundSelect() {
  const rounds = Object.keys(state.elections).sort();
  $('#round-field').hidden = rounds.length < 2;
  $('#round-select').replaceChildren(...rounds.map((round) => {
    const option = element('option', '', `${round}º turno`);
    option.value = round;
    option.selected = round === state.round;
    return option;
  }));
}

async function loadConfig() {
  const before = JSON.stringify([state.elections, state.templates]);
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Configuração do TSE indisponível (${response.status}).`);
    const config = await response.json();
    const elections = readElections(config);
    if (!Object.keys(elections).length) throw new Error('A eleição de 2026 não aparece na configuração do TSE.');
    state.elections = elections;
    for (const file of config.arq || []) {
      if (file.tp === 'u' || file.tp === 'ft') state.templates[file.tp] = file.dir;
    }
  } catch (error) {
    console.info('Usando a configuração padrão da eleição de 2026.', error);
  }
  if (!state.elections[state.round]) state.round = Object.keys(state.elections).sort()[0];
  return JSON.stringify([state.elections, state.templates]) !== before;
}

function readSelection() {
  const params = new URLSearchParams(window.location.search);
  const uf = String(params.get('uf') || '').toLowerCase();
  if (UFS.some(([code]) => code === uf)) state.uf = uf;
  const office = String(Number(params.get('cargo')));
  if (OFFICES.some(({ cd }) => cd === office)) state.office = office;
  if (params.get('turno') === '2') state.round = '2';
}

function bindControls() {
  const ufSelect = $('#uf-select');
  ufSelect.replaceChildren(...UFS.map(([code, name]) => {
    const option = element('option', '', code === 'br' ? name : `${name} (${code.toUpperCase()})`);
    option.value = code;
    option.selected = code === state.uf;
    return option;
  }));
  ufSelect.addEventListener('change', () => {
    state.uf = ufSelect.value;
    selectionChanged();
  });
  $('#round-select').addEventListener('change', (event) => {
    state.round = event.target.value;
    selectionChanged();
  });
  let searchTimer = 0;
  $('#search-input').addEventListener('input', (event) => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = event.target.value;
      state.limit = PAGE_SIZE;
      renderCandidates();
    }, 150);
  });
  $('#elected-only').addEventListener('change', (event) => {
    state.electedOnly = event.target.checked;
    state.limit = PAGE_SIZE;
    renderCandidates();
  });
  $('#more-button').addEventListener('click', () => {
    state.limit += PAGE_SIZE;
    renderCandidates();
  });
  $('#refresh-button').addEventListener('click', () => loadResults({ quiet: Boolean(state.result) }));
}

async function start() {
  readSelection();
  bindControls();
  // Results start with the known 2026 codes while the TSE configuration
  // loads; only a second round needs the configuration first.
  const config = loadConfig();
  if (!state.elections[state.round]) await config;
  selectionChanged();
  const changed = await config;
  renderRoundSelect();
  if (changed) selectionChanged();
}

start();
