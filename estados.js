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
  query: '', electedOnly: false, limit: PAGE_SIZE, parliamentScope: 'br', parliamentFocus: null, legendOpen: false, resultUrl: '',
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
    // Nationally, senators and deputies add up the files of every state.
    if (uf === 'br') return cd !== '3' && cd !== '8';
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

// Presidential photos live in the national folder; the others in the folder
// of the candidate's state (which differs per row in the national list).
function photoUrl(candidate) {
  const uf = state.office === '1' ? 'br' : candidate.uf || state.uf;
  const code = state.elections[state.round][chamberOffice(state.office, uf)] || state.elections[state.round][state.office];
  return `${fillTemplate(state.templates.ft, uf, code)}/${candidate.id}.jpeg`;
}

function candidateOutcome(candidate) {
  const status = normalize(candidate.st);
  if (/2[ºo°]?\s*turno|segundo turno/.test(status)) return 'runoff';
  if (candidate.e === 's' || (status.includes('eleito') && !status.includes('nao'))) return 'elected';
  return '';
}

// Reads one EA20 file for any state and office, so the seat chart can reuse
// the same rules for the files of every state.
function readCandidates(result, officeCd = state.office, uf = state.uf) {
  const office = (result.carg || []).find((item) => String(Number(item.cd)) === officeCd) || result.carg?.[0];
  if (!office) return { list: [], projected: false, office: null };
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
  const projected = applyProjection(result, office, list, officeCd, uf);
  return { list, projected, office };
}

function flattenCandidates(result) {
  const { list, projected } = readCandidates(result);
  state.projected = projected;
  return list;
}

const isValidCandidate = (candidate) => normalize(candidate.validity).startsWith('valido');

// While the TSE has not marked anyone, projects the outcome from the votes
// counted so far. Proportional offices use the seats the TSE already assigns
// to each party or federation (`vag`) and fill them with its most voted
// candidates; majoritarian offices follow the majority and plurality rules.
function applyProjection(result, office, list, officeCd, uf) {
  if (list.some((candidate) => candidate.outcome || candidate.status)) return false;
  const valid = list.filter(isValidCandidate);
  if (!valid.length || !valid[0].votes) return false;
  const mark = (candidates, outcome) => candidates.forEach((candidate) => { candidate.projection = outcome; });
  if (['6', '7', '8'].includes(officeCd)) {
    const groups = new Map();
    valid.forEach((candidate) => {
      if (!groups.has(candidate.seatGroup)) groups.set(candidate.seatGroup, []);
      groups.get(candidate.seatGroup).push(candidate);
    });
    groups.forEach((candidates, group) => mark(candidates.slice(0, parseTseNumber(group.vag)), 'elected'));
  } else if (officeCd === '5') {
    mark(valid.slice(0, parseTseNumber(office.nv) || 1), 'elected');
  } else if (officeCd === '3' || (officeCd === '1' && uf === 'br')) {
    const validTotal = valid.reduce((total, candidate) => total + candidate.votes, 0);
    if (String(result.t) === '2' || valid[0].votes / validTotal > .5) mark(valid.slice(0, 1), 'elected');
    else mark(valid.slice(0, 2), 'runoff');
  } else {
    return false;
  }
  return list.some((candidate) => candidate.projection);
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
  const office = result.carg?.find((item) => String(Number(item.cd)) === state.office) || result.carg?.[0] || {};
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
  image.src = photoUrl(candidate);
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
  info.append(name, element('div', 'candidate-detail', [candidate.uf?.toUpperCase(), candidate.party, candidate.group, candidate.fullName].filter(Boolean).join(' · ')));
  const mates = runningMatesText(candidate.running);
  if (mates) info.append(element('div', 'candidate-extra', mates));
  row.append(info);

  const votes = element('div', 'candidate-votes');
  // In the national list the percentage is of the candidate's own state.
  const pct = candidate.uf ? `${formatPct(candidate.pct)} em ${candidate.uf.toUpperCase()}` : formatPct(candidate.pct);
  votes.append(element('strong', '', pct), element('small', '', `${numberFormat.format(candidate.votes)} votos`));
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
    return [candidate.name, candidate.fullName, candidate.number, candidate.party, candidate.group, candidate.uf]
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

// Seat chart (hemicycle) of the elected senators and deputies. The spectrum
// position of each party is an editorial simplification used only to order
// the seats from left to right; parties below LEFT_LIMIT count as "Esquerda".
const PARLIAMENT_OFFICES = ['5', '6', '7', '8'];
const CHAMBERS = [
  { cd: '5', label: 'Senado' },
  { cd: '6', label: 'Federais' },
  { cd: '7', label: 'Estaduais' },
];
// National charts read one file per state; they are refreshed less often than
// the file on screen and downloaded a few at a time.
const PARLIAMENT_FRESH_MS = 180_000;
const PARLIAMENT_WORKERS = 4;
const LEFT_LIMIT = 5;
// Parties listed before the rest collapse under "Mais partidos".
const LEGEND_PARTIES = 8;
// Empty center of the hemicycle (share of the radius) that holds the totals,
// and the largest seat, so a small chamber does not turn into big blocks.
const HEMICYCLE_INNER = 0.5;
const MAX_SEAT = 0.13;
// Up to this many seats (a state's senators, for example) each seat is shown
// as a card with its party and name instead of a mostly empty hemicycle.
const SEAT_CARDS_LIMIT = 12;
const PARTY_INFO = {
  PCO: { pos: 0, color: '#7a1f24' },
  PSTU: { pos: 0.1, color: '#8f2328' },
  UP: { pos: 0.2, color: '#a32b30' },
  PCB: { pos: 0.3, color: '#b03236' },
  PSOL: { pos: 1, color: '#f5c542' },
  REDE: { pos: 1.5, color: '#3fbfa8', label: 'Rede' },
  PCDOB: { pos: 2, color: '#9c3a35', label: 'PCdoB' },
  PT: { pos: 3, color: '#e5484d' },
  PV: { pos: 3.5, color: '#5fbf6a' },
  PSB: { pos: 4, color: '#f2a65a' },
  PDT: { pos: 4.5, color: '#d6589a' },
  SOLIDARIEDADE: { pos: 5, color: '#a1887f', label: 'Solidariedade' },
  AVANTE: { pos: 5.2, color: '#c2a27a', label: 'Avante' },
  CIDADANIA: { pos: 5.4, color: '#ec8fb0', label: 'Cidadania' },
  PSDB: { pos: 5.6, color: '#7fa8e0' },
  MDB: { pos: 6, color: '#2f8a4a' },
  PSD: { pos: 6.3, color: '#9ccc65' },
  PODE: { pos: 6.6, color: '#a37be0', label: 'Podemos' },
  AGIR: { pos: 6.9, color: '#78909c', label: 'Agir' },
  MOBILIZA: { pos: 7, color: '#8fa3ad', label: 'Mobiliza' },
  PRD: { pos: 7.1, color: '#5d7480' },
  DC: { pos: 7.2, color: '#6e8592' },
  DEMOCRATA: { pos: 7.2, color: '#6e8592', label: 'Democrata' },
  PMB: { pos: 7.3, color: '#b0bec5' },
  UNIAO: { pos: 7.6, color: '#4fc3f7', label: 'União' },
  PP: { pos: 7.8, color: '#b3e9fb' },
  REPUBLICANOS: { pos: 8.3, color: '#5a86bd', label: 'Republicanos' },
  NOVO: { pos: 9, color: '#ff7a29', label: 'Novo' },
  PL: { pos: 9.5, color: '#4a5ee8' },
  MISSAO: { pos: 9.6, color: '#3443a8', label: 'Missão' },
};
const UNKNOWN_PARTY = { pos: 6.5, color: '#6b7a93' };
const SVG_NS = 'http://www.w3.org/2000/svg';

const seatCache = new WeakMap();
const layoutCache = new Map();
let parliamentRun = 0;
let parliamentFrame = 0;
// While the files of a new chart download, the previous chart stays on screen
// (faded) and is replaced once, instead of growing state by state.
let parliamentLoading = false;
let parliamentProgress = '';

const partyKey = (sg) => normalize(sg).replace(/[^a-z]/g, '').toUpperCase();
const partyInfo = (sg) => PARTY_INFO[partyKey(sg)] || UNKNOWN_PARTY;
const partyLabel = (sg) => partyInfo(sg).label || sg || 'Sem partido';

// The DF elects district deputies; "Estaduais" means either one.
function chamberOffice(office, uf) {
  if (office === '7' || office === '8') return uf === 'df' ? '8' : '7';
  return office;
}

const showsParliament = () => PARLIAMENT_OFFICES.includes(state.office);

function parliamentUfs() {
  return state.uf === 'br' || state.parliamentScope === 'br' ? UFS.map(([uf]) => uf).filter((uf) => uf !== 'br') : [state.uf];
}

function parliamentUrl(uf) {
  const office = chamberOffice(state.office, uf);
  return state.elections['1']?.[office] ? resultUrl(uf, office, '1') : '';
}

// Seats won in one state's file: TSE outcome first, projection otherwise.
function chamberSeats(result, office, uf) {
  if (seatCache.has(result)) return seatCache.get(result);
  const { list, projected, office: data } = readCandidates(result, office, uf);
  const winners = list.filter((candidate) => candidate.outcome === 'elected' || (!candidate.outcome && candidate.projection === 'elected'));
  const seats = {
    total: Math.max(parseTseNumber(data?.nv), winners.length),
    projected,
    seats: winners.map((candidate) => ({ party: candidate.party, name: candidate.name, uf })),
  };
  seatCache.set(result, seats);
  return seats;
}

function parliamentData() {
  const data = { states: 0, loaded: 0, total: 0, projected: false, seats: [] };
  for (const uf of parliamentUfs()) {
    const url = parliamentUrl(uf);
    if (!url) continue;
    data.states += 1;
    const entry = resultCache.get(url);
    if (!entry) continue;
    const chamber = chamberSeats(entry.result, chamberOffice(state.office, uf), uf);
    data.loaded += 1;
    data.total += chamber.total;
    data.projected ||= chamber.projected;
    data.seats.push(...chamber.seats);
  }
  return data;
}

// Seat positions on concentric arcs (unit radius), ordered left to right by
// angle so that each party fills a wedge of the hemicycle.
function hemicycleLayout(count) {
  if (layoutCache.has(count)) return layoutCache.get(count);
  const inner = HEMICYCLE_INNER;
  const radiiFor = (rows) => Array.from({ length: rows }, (_, i) => (rows === 1 ? 0.8 : inner + (1 - inner) * i / (rows - 1)));
  const capacityOf = (radius, spacing) => Math.floor(Math.PI * radius / spacing) + 1;
  let rows = 1;
  let spacing = 0.3;
  for (; rows < 40; rows += 1) {
    spacing = rows === 1 ? 0.3 : (1 - inner) / (rows - 1);
    const capacity = radiiFor(rows).reduce((sum, radius) => sum + capacityOf(radius, spacing), 0);
    if (capacity >= count) break;
  }
  const radii = radiiFor(rows);
  const radiusSum = radii.reduce((sum, radius) => sum + radius, 0);
  const perRow = radii.map((radius) => Math.min(capacityOf(radius, spacing), Math.floor(count * radius / radiusSum)));
  const byRemainder = radii.map((radius, i) => i).sort((a, b) => (count * radii[b] / radiusSum % 1) - (count * radii[a] / radiusSum % 1));
  for (let left = count - perRow.reduce((sum, n) => sum + n, 0), i = 0; left > 0; i += 1) {
    const row = byRemainder[i % rows];
    if (perRow[row] < capacityOf(radii[row], spacing)) {
      perRow[row] += 1;
      left -= 1;
    }
  }
  let size = spacing;
  const seats = [];
  radii.forEach((radius, row) => {
    const n = perRow[row];
    // A single short row stays compact around the top instead of spreading.
    const span = rows === 1 ? Math.min(Math.PI, (n - 1) * spacing / radius) : Math.PI;
    const step = n > 1 ? span / (n - 1) : 0;
    if (n > 1) size = Math.min(size, radius * step);
    for (let j = 0; j < n; j += 1) {
      const angle = n > 1 ? Math.PI / 2 + span / 2 - step * j : Math.PI / 2;
      seats.push({ angle, radius, x: radius * Math.cos(angle), y: -radius * Math.sin(angle) });
    }
  });
  seats.sort((a, b) => b.angle - a.angle || b.radius - a.radius);
  const layout = { seats, size: Math.min(size * 0.8, MAX_SEAT), hole: radii[0] - Math.min(size * 0.8, MAX_SEAT) / 2 };
  layoutCache.set(count, layout);
  return layout;
}

function svgNode(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

// Totals drawn inside the empty center, sized to fit it at any seat count.
function hemicycleCenter(value, caption, hole) {
  const group = svgNode('g', { class: 'hemicycle-center', 'aria-hidden': 'true' });
  const captionSize = Math.min(0.065, hole * 0.17);
  const valueSize = Math.min(0.32, hole * 0.7, hole * 3 / Math.max(3, value.length));
  const number = svgNode('text', { x: 0, y: -captionSize * 1.9, 'font-size': valueSize, class: 'hemicycle-value' });
  number.textContent = value;
  const text = svgNode('text', { x: 0, y: -captionSize * 0.35, 'font-size': captionSize, class: 'hemicycle-caption' });
  text.textContent = caption;
  group.append(number, text);
  return group;
}

function hemicycleSvg(ordered, label, value, caption) {
  const { seats, size, hole } = hemicycleLayout(ordered.length);
  const pad = size / 2 + 0.01;
  const svg = svgNode('svg', { viewBox: `${-1 - pad} ${-1 - pad} ${2 + pad * 2} ${1 + pad * 2}`, role: 'img', 'aria-label': label });
  const round = ordered.length > 120;
  seats.forEach((position, index) => {
    const seat = ordered[index];
    const shape = round
      ? svgNode('circle', { cx: position.x, cy: position.y, r: size / 2 })
      : svgNode('rect', {
        x: -size / 2, y: -size / 2, width: size, height: size, rx: size * 0.24,
        transform: `translate(${position.x} ${position.y}) rotate(${90 - position.angle * 180 / Math.PI})`,
      });
    shape.setAttribute('class', seat ? 'seat' : 'seat seat-open');
    if (seat) {
      shape.setAttribute('fill', partyInfo(seat.party).color);
      shape.dataset.party = partyKey(seat.party);
    }
    else shape.setAttribute('stroke-width', size * 0.14);
    const title = svgNode('title', {});
    title.textContent = seat ? `${partyLabel(seat.party)} · ${seat.name} (${seat.uf.toUpperCase()})` : 'Em disputa';
    shape.append(title);
    svg.append(shape);
  });
  svg.append(hemicycleCenter(value, caption, hole));
  return svg;
}

// Fades every seat outside the party hovered or picked in the legend.
function highlightParty(key) {
  const panel = $('#parliament');
  panel.querySelectorAll('.legend-item').forEach((item) => item.classList.toggle('is-focus', item.dataset.party === key));
  panel.querySelectorAll('.seat-card').forEach((card) => card.classList.toggle('is-dimmed', Boolean(key) && card.dataset.party !== key));
  const svg = panel.querySelector('.hemicycle svg');
  if (!svg) return;
  svg.classList.toggle('has-focus', Boolean(key));
  svg.querySelectorAll('.seat').forEach((seat) => seat.classList.toggle('is-focus', Boolean(key) && seat.dataset.party === key));
}

function chamberButton(label, pressed, onClick) {
  const button = element('button', 'pill', label);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

function parliamentView() {
  return [state.uf, state.office, state.uf === 'br' ? 'br' : state.parliamentScope].join('|');
}

function parliamentHead() {
  const available = officesFor(state.uf, '1').map(({ cd }) => chamberOffice(cd, state.uf));
  const chambers = element('div', 'pill-group');
  chambers.append(...CHAMBERS.map(({ cd, label }) => {
    const office = chamberOffice(cd, state.uf);
    const button = chamberButton(label, office === state.office, () => {
      state.office = office;
      selectionChanged();
    });
    button.disabled = !available.includes(office);
    return button;
  }));
  const scopes = element('div', 'pill-group pill-group-small');
  scopes.append(...[['br', 'Brasil'], ['uf', state.uf.toUpperCase()]].map(([scope, label]) =>
    chamberButton(label, state.parliamentScope === scope, () => {
      state.parliamentScope = scope;
      renderParliament();
      loadParliament();
    })));
  const head = element('div', 'parliament-head');
  head.append(chambers);
  if (state.uf !== 'br') head.append(scopes);
  return head;
}

function renderParliament() {
  const panel = $('#parliament');
  const visible = showsParliament();
  panel.hidden = !visible;
  $('#results-layout').classList.toggle('has-parliament', visible && state.uf !== 'br');
  $('#results-layout').classList.toggle('is-national', visible && state.uf === 'br');
  if (!visible) return;

  const view = parliamentView();
  if (parliamentLoading && panel.childElementCount) {
    panel.classList.toggle('is-loading', panel.dataset.view !== view);
    panel.querySelector('.parliament-head').replaceWith(parliamentHead());
    panel.querySelector('.parliament-progress').textContent = parliamentProgress;
    return;
  }
  const data = parliamentData();
  const signature = [view, data.total, data.loaded, data.projected, data.seats.map((seat) => `${seat.party}${seat.name}`).join()].join('|');
  panel.classList.remove('is-loading');
  if (!parliamentLoading && panel.dataset.signature === signature) {
    panel.querySelector('.parliament-progress').textContent = '';
    return;
  }
  panel.dataset.view = view;
  panel.dataset.signature = parliamentLoading ? '' : signature;
  const head = parliamentHead();
  const groups = new Map();
  data.seats.forEach((seat) => {
    const key = partyKey(seat.party);
    if (!groups.has(key)) groups.set(key, { party: seat.party, info: partyInfo(seat.party), seats: [] });
    groups.get(key).seats.push(seat);
  });
  const ordered = [...groups.values()].sort((a, b) => a.info.pos - b.info.pos || a.party.localeCompare(b.party));
  const left = ordered.filter((group) => group.info.pos < LEFT_LIMIT);
  const right = ordered.filter((group) => group.info.pos >= LEFT_LIMIT);
  const count = (list) => list.reduce((sum, group) => sum + group.seats.length, 0);
  const defined = data.seats.length;
  const open = Math.max(0, data.total - defined);
  const majority = Math.floor(data.total / 2) + 1;

  const spectrum = element('div', 'spectrum');
  const labels = element('div', 'spectrum-labels');
  const side = (name, value, reverse) => {
    const node = element('span', 'spectrum-side');
    const number = element('strong', '', numberFormat.format(value));
    node.append(...(reverse ? [number, document.createTextNode(name)] : [document.createTextNode(name), number]));
    return node;
  };
  labels.append(side('Esquerda', count(left)), element('span', 'spectrum-majority', data.total ? numberFormat.format(majority) : ''), side('Direita', count(right), true));
  labels.children[1].title = 'Cadeiras para a maioria';
  const bar = element('div', 'spectrum-bar');
  [['left', count(left)], ['open', open], ['right', count(right)]].forEach(([kind, value]) => {
    const segment = element('span', `spectrum-${kind}`);
    segment.style.flexGrow = String(value);
    bar.append(segment);
  });
  bar.append(element('span', 'spectrum-marker'));
  spectrum.append(labels, bar);

  const chart = element('div', 'hemicycle');
  const seatsInOrder = [...left.flatMap((group) => group.seats), ...Array(open).fill(null), ...right.flatMap((group) => group.seats)];
  const caption = data.total ? `de ${numberFormat.format(data.total)} definidas` : 'aguardando o TSE';
  if (seatsInOrder.length && seatsInOrder.length <= SEAT_CARDS_LIMIT) {
    chart.className = 'seat-cards';
    const total = element('div', 'seat-cards-total');
    total.append(element('strong', '', numberFormat.format(defined)), element('span', '', caption));
    const list = element('ul', 'seat-cards-list');
    list.append(...seatsInOrder.map((seat) => {
      const card = element('li', seat ? 'seat-card' : 'seat-card seat-card-open');
      const swatch = element('span', 'legend-swatch');
      if (seat) {
        swatch.style.background = partyInfo(seat.party).color;
        card.dataset.party = partyKey(seat.party);
      }
      const text = element('span', 'seat-card-text');
      text.append(element('strong', '', seat ? partyLabel(seat.party) : 'Em disputa'), element('span', '', seat ? seat.name : 'Aguardando resultado'));
      card.append(swatch, text);
      return card;
    }));
    chart.append(total, list);
  } else if (seatsInOrder.length && !parliamentLoading) {
    chart.append(hemicycleSvg(seatsInOrder, `${numberFormat.format(defined)} de ${numberFormat.format(data.total)} cadeiras definidas`, numberFormat.format(defined), caption));
  } else {
    chart.classList.add('is-empty');
    const center = element('div', 'hemicycle-empty');
    if (parliamentLoading) center.append(element('span', '', 'Carregando as cadeiras…'));
    else center.append(element('strong', '', '0'), element('span', '', caption));
    chart.append(center);
  }

  // Every party is listed by seats; hovering (or tapping) one highlights its
  // seats. The smaller ones stay folded so a big chamber still reads quickly.
  const bySize = [...groups.values()].sort((a, b) => b.seats.length - a.seats.length || a.info.pos - b.info.pos);
  const legendItem = (group) => {
    const key = partyKey(group.party);
    const item = element('button', 'legend-item');
    item.type = 'button';
    item.dataset.party = key;
    item.title = `${partyLabel(group.party)}: ${group.seats.length} de ${data.total} cadeiras`;
    const swatch = element('span', 'legend-swatch');
    swatch.style.background = group.info.color;
    item.append(swatch, element('span', 'legend-name', partyLabel(group.party)), element('strong', '', numberFormat.format(group.seats.length)));
    item.addEventListener('mouseenter', () => highlightParty(key));
    item.addEventListener('focus', () => highlightParty(key));
    item.addEventListener('blur', () => highlightParty(state.parliamentFocus));
    item.addEventListener('click', () => {
      state.parliamentFocus = state.parliamentFocus === key ? null : key;
      highlightParty(state.parliamentFocus);
    });
    return item;
  };
  const legend = element('div', 'parliament-legend');
  // Leaving one item for the next keeps the highlight; only leaving the whole
  // legend restores it, so the chart does not flash between parties.
  legend.addEventListener('mouseleave', () => highlightParty(state.parliamentFocus));
  const main = element('div', 'legend-grid');
  const shown = bySize.length <= LEGEND_PARTIES + 3 ? bySize.length : LEGEND_PARTIES;
  main.append(...bySize.slice(0, shown).map(legendItem));
  if (open || !defined) {
    const pending = element('span', 'legend-item legend-open');
    pending.append(element('span', 'legend-swatch'), element('span', 'legend-name', 'Em disputa'), element('strong', '', numberFormat.format(open)));
    main.append(pending);
  }
  legend.append(main);
  const rest = bySize.slice(shown);
  if (rest.length) {
    const more = element('details', 'legend-more');
    more.open = state.legendOpen;
    more.addEventListener('toggle', () => { state.legendOpen = more.open; });
    const restSeats = rest.reduce((sum, group) => sum + group.seats.length, 0);
    more.append(element('summary', '', `Mais ${rest.length} partidos · ${numberFormat.format(restSeats)} cadeiras`));
    const grid = element('div', 'legend-grid');
    grid.append(...rest.map(legendItem));
    more.append(grid);
    legend.append(more);
  }

  const notes = [];
  if (data.loaded < data.states) notes.push(`Dados de ${data.loaded} de ${data.states} estados carregados.`);
  if (state.office === '5') notes.push('Em 2026 são eleitos 2 senadores por estado (54 das 81 cadeiras).');
  if (data.projected) notes.push('Inclui projeção pelos votos apurados até agora.');
  notes.push('Esquerda e direita: classificação simplificada por partido.');
  const note = element('p', 'parliament-note', notes.join(' '));

  const cards = chart.classList.contains('seat-cards');
  const title = element('div', 'parliament-title');
  title.append(element('span', 'field-label', 'COMPOSIÇÃO'), element('span', 'parliament-progress', parliamentProgress));
  panel.replaceChildren(title, head, spectrum, chart, ...(cards ? [] : [legend]), note);
  if (!groups.has(state.parliamentFocus)) state.parliamentFocus = null;
  highlightParty(state.parliamentFocus);
}

function scheduleParliamentRender() {
  if (parliamentFrame) return;
  parliamentFrame = window.requestAnimationFrame(() => {
    parliamentFrame = 0;
    renderParliament();
  });
}

// Downloads the files of every state for the national chart, a few at a time,
// redrawing as each one arrives.
async function loadParliament() {
  const run = ++parliamentRun;
  const queue = showsParliament() ? parliamentUfs().map(parliamentUrl).filter((url) => {
    const cached = url && resultCache.get(url);
    return url && !(cached && Date.now() - cached.fetchedAt < PARLIAMENT_FRESH_MS);
  }) : [];
  const total = queue.length;
  let done = 0;
  parliamentLoading = total > 0;
  parliamentProgress = total > 1 ? `CARREGANDO 0/${total}` : '';
  scheduleParliamentRender();
  const worker = async () => {
    while (queue.length && run === parliamentRun) {
      try {
        await fetchResult(queue.shift());
      } catch {
        // Not published yet; counted as a state still loading.
      }
      done += 1;
      if (run === parliamentRun && total > 1) {
        parliamentProgress = `CARREGANDO ${done}/${total}`;
        scheduleParliamentRender();
      }
    }
  };
  await Promise.all(Array.from({ length: PARLIAMENT_WORKERS }, worker));
  if (run !== parliamentRun) return;
  parliamentLoading = false;
  parliamentProgress = '';
  scheduleParliamentRender();
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

function setResultsLoading(loading) {
  $('.results-panel').classList.toggle('is-loading', loading);
  $('#summary').classList.toggle('is-loading', loading);
}

// A new selection keeps the previous list on screen (faded) until its file
// arrives; the skeleton only shows when there is nothing to keep.
function startLoading() {
  if (state.result) {
    setResultsLoading(true);
    return;
  }
  $('#more-button').hidden = true;
  $('#results-count').textContent = '';
  $('#projection-note').hidden = true;
  showMessage('');
  showSkeleton();
}

function clearResults() {
  state.result = null;
  state.resultUrl = '';
  state.candidates = [];
  state.projected = false;
  setResultsLoading(false);
  renderSummary();
  renderCandidates();
}

function showResult(result, url) {
  // A refresh that brings the same TSE file keeps the list as it is.
  const unchanged = state.resultUrl === url && state.result && result.idg && state.result.idg === result.idg;
  state.result = result;
  state.resultUrl = url;
  setResultsLoading(false);
  const time = `${result.dg || ''} ${result.hg || ''}`.trim();
  setStatus('official', `DADOS OFICIAIS DO TSE${time ? ` · ${time}` : ''}`);
  loadParliament();
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

const isNational = () => state.uf === 'br' && PARLIAMENT_OFFICES.includes(state.office);

const sumOf = (results, read) => results.reduce((total, result) => total + parseTseNumber(read(result)), 0);
const pctOf = (part, whole) => (whole ? (part / whole * 100).toFixed(2).replace('.', ',') : '0');

// A national summary built from the state files loaded so far, in the same
// shape as an EA20 file so the summary cards read it unchanged.
function nationalResult(results) {
  const sections = sumOf(results, (result) => result.s?.st);
  const allSections = sumOf(results, (result) => result.s?.ts);
  const votes = sumOf(results, (result) => result.v?.tv);
  const valid = sumOf(results, (result) => result.v?.vv);
  const validBase = sumOf(results, (result) => result.v?.vvc ?? result.v?.vv);
  const blank = sumOf(results, (result) => result.v?.vb);
  const nulls = sumOf(results, (result) => result.v?.tvn ?? result.v?.vn);
  const voters = sumOf(results, (result) => result.e?.te);
  const absent = sumOf(results, (result) => result.e?.a);
  const done = results.length === UFS.length - 1 && results.every((result) => result.tf === 's');
  const latest = results.map((result) => [result.dg, result.hg]).sort(([dateA, hourA], [dateB, hourB]) =>
    (dateA || '').split('/').reverse().join('').localeCompare((dateB || '').split('/').reverse().join('')) || (hourA || '').localeCompare(hourB || '')).pop() || [];
  return {
    national: true, tf: done ? 's' : 'n', dg: latest[0], hg: latest[1],
    s: { st: sections, ts: allSections, pst: pctOf(sections, allSections) },
    v: { vv: valid, pvv: pctOf(valid, validBase), vb: blank, pvb: pctOf(blank, votes), tvn: nulls, ptvn: pctOf(nulls, votes) },
    e: { a: absent, pa: pctOf(absent, voters) },
    carg: [{ cd: state.office, nv: String(sumOf(results, (result) => readCandidates(result, chamberOffice(state.office, result.cdabr), result.cdabr).office?.nv)) }],
  };
}

const nationalLists = new WeakMap();
function stateCandidates(result, uf) {
  if (!nationalLists.has(result)) {
    const { list, projected } = readCandidates(result, chamberOffice(state.office, uf), uf);
    nationalLists.set(result, { projected, list: list.map((candidate) => ({ ...candidate, uf })) });
  }
  return nationalLists.get(result);
}

// Joins the candidates of every state loaded so far into a single ranking.
function renderNational() {
  const loaded = UFS.map(([uf]) => uf).filter((uf) => uf !== 'br').map((uf) => {
    const url = parliamentUrl(uf);
    return url && resultCache.get(url) ? { uf, result: resultCache.get(url).result } : null;
  }).filter(Boolean);
  if (!loaded.length) return false;
  const candidates = [];
  let projected = false;
  loaded.forEach(({ uf, result }) => {
    const entry = stateCandidates(result, uf);
    projected ||= entry.projected;
    candidates.push(...entry.list);
  });
  candidates.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'pt-BR'));
  candidates.forEach((candidate, index) => { candidate.rank = index + 1; });
  state.result = nationalResult(loaded.map(({ result }) => result));
  state.resultUrl = `br-${state.office}`;
  setResultsLoading(false);
  state.candidates = candidates;
  state.projected = projected;
  const time = `${state.result.dg || ''} ${state.result.hg || ''}`.trim();
  const missing = UFS.length - 1 - loaded.length;
  setStatus('official', missing ? `DADOS OFICIAIS DO TSE · ${loaded.length} DE ${UFS.length - 1} ESTADOS` : `DADOS OFICIAIS DO TSE${time ? ` · ${time}` : ''}`);
  renderSummary();
  renderCandidates();
  return true;
}

async function loadNational({ quiet = false } = {}) {
  const request = state.request;
  const loading = loadParliament();
  if (!quiet && !parliamentLoading) renderNational();
  else if (!quiet) startLoading();
  await loading;
  if (request !== state.request) return;
  if (!renderNational()) {
    clearResults();
    setStatus('loading', 'AGUARDANDO PUBLICAÇÃO DO TSE');
    showMessage('Os resultados deste cargo ainda não foram publicados pelo TSE. A página tenta de novo automaticamente.');
  }
  scheduleRefresh();
}

async function loadResults({ quiet = false } = {}) {
  window.clearTimeout(state.timer);
  if (isNational()) {
    state.request += 1;
    loadNational({ quiet });
    return;
  }
  const request = ++state.request;
  const url = resultUrl();
  const cached = cachedResult(url);
  if (!quiet) {
    if (cached) showResult(cached.result, url);
    else startLoading();
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
    showResult(entry.result, url);
    scheduleRefresh();
    prefetchOtherOffices();
  } catch (error) {
    if (request !== state.request) return;
    console.info('Resultado do TSE indisponível.', error);
    if (state.result && state.resultUrl === url) {
      setStatus('error', 'TSE SEM ATUALIZAÇÃO · MOSTRANDO A ÚLTIMA LEITURA');
    } else if (error.missing) {
      clearResults();
      setStatus('loading', 'AGUARDANDO PUBLICAÇÃO DO TSE');
      showMessage('Os resultados deste cargo ainda não foram publicados pelo TSE. A página tenta de novo automaticamente.');
    } else {
      clearResults();
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
  if (uf === 'br') return;
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
  loadParliament();
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
