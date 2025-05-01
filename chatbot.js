/* ---------- DeepSeek helper ---------- */
const askDeepSeek = (prompt) => window.deepseek.ask(prompt);

/* ---------- DeepSeek helper with 5s timeout & 1 retry ---------- */
async function askDeepSeekSafe(prompt, timeout = 5000, retries = 1) {
  for (let attempt = 0; attempt <= retries; ++attempt) {
    try {
      return await Promise.race([
        askDeepSeek(prompt),  // IPC call
        new Promise(
            (_, rej) => setTimeout(
                () => rej(
                    new Error('Sorry, DeepSeek timed out. Please try again.')),
                timeout))
      ]);
    } catch (err) {
      if (attempt === retries) throw err;  // bubble up last error
      /* fall-through -> retry immediately with the same prompt */
    }
  }
}

/* ---------------- Chatbot frontend logic ---------------------- */
document.addEventListener('DOMContentLoaded', () => {
  const eqBuckets = document.getElementById('eq-buckets');
  const chatbot = document.getElementById('chatbot');
  const chatMsgs = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatForm = document.getElementById('chat-input-area');

  /* ─── maintain height (>= 40 % vh) ──────────────────────────── */
  const syncHeight = () => {
    const h = eqBuckets ? eqBuckets.offsetHeight : 0;
    chatbot.style.height = `${Math.max(h, window.innerHeight * 0.40)}px`;
  };
  syncHeight();
  window.addEventListener('resize', syncHeight);

  /* ─── LOCAL HELPERS ─────────────────────────────── */
  const suitSym = {c: '♣', d: '♦', h: '♥', s: '♠'};
  const streetTxt = d => (['Flop', 'Turn', 'River'][d] || 'Flop');
  const playerTxt = p =>
      (p === 1     ? 'Out of Position (OOP)' :
           p === 0 ? 'In Position (IP)' :
                     'Unknown');
  const fmtBoard = cards =>
      cards.map(c => c[0] + (suitSym[c[1]] || c[1])).join(' ');
  const fmtCard = c => c[0] + (suitSym[c[1]] || c[1]);
  const appendBubble = (txt, cls) => {
    const div = document.createElement('div');
    div.className = `chat-bubble ${cls}`;
    div.textContent = txt;
    chatMsgs.appendChild(div);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  };
  const fmtCombo = c =>
      c[0] + (suitSym[c[1]] || c[1]) + c[2] + (suitSym[c[3]] || c[3]);

  const HAND_SYNONYMS = {
    'pocket aces': 'AA',
    aces: 'AA',
    'pocket rockets': 'AA',
    bullets: 'AA',
    'pocket kings': 'KK',
    kings: 'KK',
    cowboys: 'KK',
    'pocket queens': 'QQ',
    queens: 'QQ',
    ladies: 'QQ',
    'pocket jacks': 'JJ',
    jacks: 'JJ',
    hooks: 'JJ',
    'pocket tens': 'TT',
    tens: 'TT',
    dimes: 'TT',
    'pocket nines': '99',
    nines: '99',
    gretzky: '99',
    'pocket eights': '88',
    eights: '88',
    snowmen: '88',
    'pocket sevens': '77',
    sevens: '77',
    'hockey sticks': '77',
    'pocket sixes': '66',
    sixes: '66',
    'route 66': '66',
    'pocket fives': '55',
    fives: '55',
    nickels: '55',
    'pocket fours': '44',
    fours: '44',
    sailboats: '44',
    'pocket threes': '33',
    threes: '33',
    crabs: '33',
    'pocket twos': '22',
    twos: '22',
    'pocket deuces': '22',
    deuces: '22',
    ducks: '22',
    'big slick suited': 'AKs',
    'big slick offsuit': 'AKo',
    'seven deuce': '72o',
  };
  const _RANK_WORD =
      '(?:ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|two)';
  const _RANK_CHAR = '[AKQJT2-9]';
  const _SUIT_CHAR = '[cdhs]';
  const _SUIT_WORD = '(?:clubs|diamonds|hearts|spades)';
  const HAND_REGEX = new RegExp(
      [
        // AKs, 99, 76o
        `\\b${_RANK_CHAR}{2}(?:[so])?\\b`,
        // AhKd, 7s7d
        `\\b${_RANK_CHAR}${_SUIT_CHAR}${_RANK_CHAR}${_SUIT_CHAR}\\b`,
        // "AK suited", "99 offsuit"
        `\\b${_RANK_CHAR}{2}\\s+(?:suited|offsuit)\\b`,
        // "32 of spades"
        `\\b${_RANK_CHAR}{2}\\s+of\\s+${_SUIT_WORD}\\b`,
        // "ace king suited", "ten three offsuit"
        `\\b${_RANK_WORD}\\s+${_RANK_WORD}\\s+(?:suited|offsuit)\\b`,
        // "ten three of diamonds"
        `\\b${_RANK_WORD}\\s+${_RANK_WORD}\\s+of\\s+${_SUIT_WORD}\\b`
      ].join('|'),
      'gi');
  const RANK_VALUE = 'AKQJT98765432';
  const WORD2RANK = {
    ace: 'A',
    king: 'K',
    queen: 'Q',
    jack: 'J',
    ten: 'T',
    nine: '9',
    eight: '8',
    seven: '7',
    six: '6',
    five: '5',
    four: '4',
    three: '3',
    two: '2'
  };
  const WORD2SUIT = {clubs: 'c', diamonds: 'd', hearts: 'h', spades: 's'};
  const SUITS = 'cdhs';
  function _order(r1, r2) {
    return RANK_VALUE.indexOf(r1) < RANK_VALUE.indexOf(r2) ? r1 + r2 : r2 + r1;
  }
  const _CANON_RE = new RegExp(`^(${_RANK_CHAR})(${_RANK_CHAR})([os])?$`, 'i');
  const _SPECIFIC_RE = new RegExp(
      `^(${_RANK_CHAR})(${_SUIT_CHAR})(${_RANK_CHAR})(${_SUIT_CHAR})$`, 'i');
  const _PART_CANON_RE =
      new RegExp(`^(${_RANK_CHAR}{2})\\s+(suited|offsuit)$`, 'i');
  const _PART_SPEC_RE =
      new RegExp(`^(${_RANK_CHAR}{2})\\s+of\\s+(${_SUIT_WORD})$`, 'i');
  const _FULL_CANON_RE = new RegExp(
      `^(${_RANK_WORD})\\s+(${_RANK_WORD})\\s+(suited|offsuit)$`, 'i');
  const _FULL_SPEC_RE = new RegExp(
      `^(${_RANK_WORD})\\s+(${_RANK_WORD})\\s+of\\s+(${_SUIT_WORD})$`, 'i');
  function _canonical(token) {
    const t = token.trim().toLowerCase();
    let m;
    if ((m = t.match(_CANON_RE)))
      return _order(m[1].toUpperCase(), m[2].toUpperCase()) +
          (m[3] || '').toLowerCase();
    if ((m = t.match(_SPECIFIC_RE))) {
      let [, r1, s1, r2, s2] = m;
      r1 = r1.toUpperCase();
      r2 = r2.toUpperCase();
      if (RANK_VALUE.indexOf(r1) > RANK_VALUE.indexOf(r2))
        [r1, r2, s1, s2] = [r2, r1, s2, s1];
      return `${r1}${s1.toLowerCase()}${r2}${s2.toLowerCase()}`;
    }
    if ((m = t.match(_PART_CANON_RE)))
      return _order(m[1][0], m[1][1]).toUpperCase() + m[2][0];
    if ((m = t.match(_PART_SPEC_RE))) {
      const [, ranks, suitWord] = m;
      const s = WORD2SUIT[suitWord.toLowerCase()];
      const sorted = _order(ranks[0], ranks[1]).toUpperCase();
      return `${sorted[0]}${s}${sorted[1]}${s}`;
    }
    if ((m = t.match(_FULL_CANON_RE))) {
      const [, w1, w2, flag] = m;
      return _order(WORD2RANK[w1], WORD2RANK[w2]) +
          (flag.startsWith('s') ? 's' : 'o');
    }
    if ((m = t.match(_FULL_SPEC_RE))) {
      const [, w1, w2, suitWord] = m;
      const s = WORD2SUIT[suitWord.toLowerCase()];
      const sorted = _order(WORD2RANK[w1], WORD2RANK[w2]);
      return `${sorted[0]}${s}${sorted[1]}${s}`;
    }
    throw new Error(`Unrecognised hand format: ${token}`);
  }
  function _expand(tag) {
    if (tag.length === 4) return [tag];
    const [f, s] = tag;
    if (f === s) {
      const out = [];
      for (const a of SUITS)
        for (const b of SUITS)
          if (a !== b) out.push(`${f}${a}${s}${b}`);
      return out;
    }
    if (tag.length === 3) {
      const flag = tag[2];
      if (flag === 's') return SUITS.split('').map(x => `${f}${x}${s}${x}`);
      if (flag === 'o') {
        const o = [];
        for (const a of SUITS)
          for (const b of SUITS)
            if (a !== b) o.push(`${f}${a}${s}${b}`);
        return o;
      }
    }
    const suited = SUITS.split('').map(x => `${f}${x}${s}${x}`);
    const offs = [];
    for (const a of SUITS)
      for (const b of SUITS)
        if (a !== b) offs.push(`${f}${a}${s}${b}`);
    return suited.concat(offs);
  }
  function extract_combos(prompt) {
    const canon = [];
    const low = prompt.toLowerCase();
    for (const [ph, tag] of Object.entries(HAND_SYNONYMS))
      if (low.includes(ph)) canon.push(tag);
    for (const tok of prompt.match(HAND_REGEX) || [])
      canon.push(_canonical(tok));
    const uniq = [...new Set(canon)];
    const combos = new Set();
    for (const tag of uniq) _expand(tag).forEach(c => combos.add(c));
    return [...combos];
  }
  /* returns a pretty comma-separated list, or a placeholder */
  const listActions = () =>
      (Array.isArray(window.currentActions) && window.currentActions.length) ?
      window.currentActions.join(', ') :
      '(actions not loaded)';
  /* ── pretty board by street ─────────────────────────────── */
  function prettyBoard() {
    const cards = (window.boardCardsForCurrentDepth?.() || []);
    const flop = cards.slice(0, 3).map(fmtCard).join(' ');
    const turn = cards[3] ? fmtCard(cards[3]) : '';
    const river = cards[4] ? fmtCard(cards[4]) : '';
    return [
      `Flop : ${flop || '(—)'}`,
      turn && `Turn : ${turn}`,
      river && `River: ${river}`,
    ].filter(Boolean)
        .join('\n');
  }

  /* ── summarise one physical combo ("AhKh") ── */
  function summariseCombo(cmb) {
    if (!window.currentSNode || !window.currentActions) return null;

    const board = (window.boardCardsForCurrentDepth?.() || []);
    if (window.comboHasBoardCard?.(cmb, board)) return null;

    const vecObj = window.currentSNode[cmb];
    if (!vecObj) return null;

    const vec = Object.keys(vecObj)
                    .sort((a, b) => Number(a) - Number(b))
                    .slice(0, window.currentActions.length)  // strip EV
                    .map(k => vecObj[k]);

    const tot = vec.reduce((s, x) => s + x, 0) || 1;
    const parts = vec.map(
        (f, i) => `${window.currentActions[i]} ${(f / tot * 100).toFixed(0)}%`);
    return `${fmtCombo(cmb)} : ${parts.join(' / ')}`;
  }

  /* ── summarise every combo represented by a canonical tag ("AKs", "88", ...)
   */
  function summariseTag(tag) {
    const combos = _expand(tag);
    const lines = combos.map(summariseCombo).filter(l => l);
    if (!lines.length) return '';

    // ── compute per-action averages ─────────────────────────────
    const freqMatrix = combos
                           .map(c => {
                             const v = window.currentSNode[c];
                             if (!v) return null;
                             const arr =
                                 Object.keys(v)
                                     .sort((a, b) => +a - +b)
                                     .slice(0, window.currentActions.length)
                                     .map(k => v[k]);
                             return arr;
                           })
                           .filter(r => r);
    const actionAvgs = window.currentActions.map((act, i) => {
      const avg =
          freqMatrix.reduce((sum, row) => sum + row[i], 0) / freqMatrix.length;
      return `${act} ${(avg * 100).toFixed(0)}%`;
    });

    // ── assemble full block ─────────────────────────────────────
    return [
      // title + averages
      `${tag} (avg: ${actionAvgs.join(' / ')})`,
      // individual combos
      ...lines
    ].join('\n');
  }

  /* ── canonical tags directly from the prompt (no expansion) ── */
  function extract_tags(prompt) {
    const tags = new Set();
    const low = prompt.toLowerCase();
    for (const [ph, tag] of Object.entries(HAND_SYNONYMS))
      if (low.includes(ph)) tags.add(tag);

    (prompt.match(HAND_REGEX) || []).forEach(tok => tags.add(_canonical(tok)));
    return [...tags];
  }

  /* ─── submit handler ────────────────────────────────────────── */
  chatForm.addEventListener('submit', e => {
    e.preventDefault();
    const q = chatInput.value.trim();
    if (!q) return;

    appendBubble(q, 'user');
    chatInput.value = '';
    chatInput.focus();

    /* delay slightly so the UI feels snappy but stays responsive */
    setTimeout(async () => {
      try {
        /* ---------- build the full analytics text ---------------- */
        const tags = extract_tags(q);  // canonical tags (AKs, 88, …)
        const depth = window.currentDepth ?? 0;

        let promptText = [
          `User's Question: ${q}`,
          `${prettyBoard()}`,
          `Current Street : ${streetTxt(depth)}`,
          `Player         : ${playerTxt(window.currentPlayer)}`,
        ].join('\n');

        /* Hand-strength table (EV/EQ) */
        const phase = getEquityPhase();
        const eqMap = (window.equityMap[phase] ||
                       {})[window.currentPlayer === 0 ? 'hero' : 'villain'] ||
            {};
        if (tags.length) {
          promptText += `\n\n--- Hand Strength ---`;
          tags.forEach(tag => {
            _expand(tag).forEach(cmb => {
              const vec = window.currentSNode[cmb];
              if (!vec) return;
              const arr =
                  Object.keys(vec).sort((a, b) => +a - +b).map(k => vec[k]);
              const ev = arr[arr.length - 1].toFixed(2);
              const eq = (eqMap[cmb] !== undefined ?
                              eqMap[cmb] :
                              eqMap[cmb.slice(2, 4) + cmb.slice(0, 2)])
                             ?.toFixed(0) ||
                  '--';
              promptText += `\n${fmtCombo(cmb)} : EV ${ev} / EQ ${eq}%`;
            });
          });
        }

        /* Strategy blocks */
        const strat = tags.map(t => summariseTag(t)).filter(Boolean);
        promptText += strat.length ?
            `\n\n--- Optimal strategy ---\n\n${strat.join('\n\n')}` :
            '\n\n(no poker hands detected in your question)';

        /* Range-vs-Range equities */
        const oopBuckets = computeBucketPercentages(
            (window.equityMap[phase] || {}).villain || {});
        const ipBuckets = computeBucketPercentages(
            (window.equityMap[phase] || {}).hero || {});
        promptText += `\n\n--- Range vs Range Equities ---` +
            `\n\n(Frequencies represent the percentage of hands per equity bucket)\nOOP:`;
        oopBuckets.forEach(
            b => promptText += `\n- ${b.label}: ${b.pct.toFixed(1)}%`);
        promptText += `\n\nIP:`;
        ipBuckets.forEach(
            b => promptText += `\n- ${b.label}: ${b.pct.toFixed(1)}%`);

        /* ---------- send to DeepSeek (w/ timeout + thinking bubble) ---- */
        const deepseekPrompt = `${promptText}\n\n` +
            'Reply to the user prompt concisely in 1-2 short sentences in American English. ' +
            'Integrate the hand strength information when appropriate in your response.' +
            'Equities and EVs are mostly approximate, so avoid minute decimal comparisons.' +
            'Do not try to explain the reasoning why a certain action is optimal. Only provide the quantitative hand strength information you are given.' +
            'Your responses should be objective but in a friendly tone. Users are mostly beginner and intermediate.' +
            "If the user asks about a specific hand but you see no optimal strategy specific for it, it means this hand is not in the user range. In this case, add a sentence in a new line saying: `Note: hand specified is not in player's range, so this response may be inaccurate.`" +
            'Do not write in markdown. Do not use bold or italics to highlight text.';

        // show animated “thinking …” bubble
        const thinking = document.createElement('div');
        thinking.className = 'chat-bubble bot thinking';
        thinking.innerHTML =
            '<span class="dot dot1">.</span><span class="dot dot2">.</span><span class="dot dot3">.</span>';
        chatMsgs.appendChild(thinking);
        chatMsgs.scrollTop = chatMsgs.scrollHeight;

        let answer;
        try {
          answer = await askDeepSeekSafe(
              deepseekPrompt, 5000, 1);  // 5 s + 1 retry
        } catch (err) {
          answer = `(DeepSeek error) ${err.message}`;
        }

        thinking.remove();            // clear the ellipsis bubble
        appendBubble(answer, 'bot');  // show final result (or error)

      } catch (err) {
        appendBubble(`(DeepSeek error) ${err.message}`, 'bot');
      }
    }, 120);
  });
});
