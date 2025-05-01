const suitSymbol = {
  c: '♣',
  d: '♦',
  h: '♥',
  s: '♠'
};
const SUITS_SHORT = ['c', 'd', 'h', 's'];
const RANKS_SHORT =
    ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const FULL_DECK = [];
RANKS_SHORT.forEach(rank => {
  SUITS_SHORT.forEach(suit => {
    FULL_DECK.push(rank + suit);
  });
});

function formatCombo(cmb) {
  // cmb is like "AhKd" (4 chars: rank1, suit1, rank2, suit2)
  if (cmb.length !== 4) return cmb;
  const [r1, s1, r2, s2] = cmb.split('');
  return `${r1}${suitSymbol[s1] || s1}${r2}${suitSymbol[s2] || s2}`;
}

// pick which msgpack phase to use based on currentDepth
function getEquityPhase() {
  switch (window.currentDepth) {
    case 1:
      return 'turn';
    case 2:
      return 'river';
    default:
      return 'flop';
  }
}

// tracks expanded nodes in the JSON tree
window._lastExpandedContainer = null;
// used for computing equities
window._hasComputedInitialEquities = false;
// tracks if we need to recompute equities
// since equities are non-weighted, we only need to recompute them once per
// street
window._lastEquityCalculationDepth = -1;

// Track if a solution is loaded
window._isSolutionLoaded = false;

// Equity map from main process
window.equityMap = {};
window.electronAPI.onEquityData((_, data) => {
  window.equityMap = {...window.equityMap, ...data};
  hideLoadingOverlay();
  renderEqBuckets();
  const phase = getEquityPhase();
  const eqData = window.equityMap[phase] || {};
  const playerEquityMap =
      window.currentPlayer === 0 ? (eqData.hero || {}) : (eqData.villain || {});
  if (window.currentSNode && window.currentActions) {
    const strategyDistribution = computeEquityStrategyDistribution(
        window.currentSNode, window.currentActions, playerEquityMap, BUCKETS);
    renderEquityStrategyChart(strategyDistribution, window.currentActions);
  } else {
    renderEquityStrategyChart([], []);
  }
  renderEqDistribution();
  if (window.currentSNode && window.currentActions) {
    applyToChart(window.currentSNode, window.currentActions);
  }
});

window.electronAPI.onRootTree((_evt, data) => {
  const jsonViewer = document.getElementById('json-viewer');

  if (!data || typeof data !== 'object' || !data.root) {
    console.error('onRootTree received invalid data structure:', data);
    jsonViewer.innerHTML =
        '<p style="color: red;">Error: Received invalid solution data.</p>';
    hideLoadingOverlay();
    if (saveBtn) saveBtn.style.display = 'none';  // Hide save button
    window._isSolutionLoaded = false;
    return;
  }

  const root = data.root;
  // ["Ac", "Kd", "Qs"] format
  const explicitFlopBoard = data.flop || [];

  updateDropdowns(root, explicitFlopBoard);
  jsonViewer.innerHTML = '';
  createTreeView(root, jsonViewer, {path: ''});

  const saveBtn = document.getElementById('saveSolutionBtn');
  if (saveBtn) {
    saveBtn.style.display = 'inline-block';
  }
  window._isSolutionLoaded = true;  // Mark solution as loaded

  window.equityMap = {};
  window._hasComputedInitialEquities = true;  // Mark ready for equity calls

  // Clear charts and EV display
  renderEqBuckets();
  renderEquityStrategyChart([], []);
  renderEqDistribution();
  const pokerChartContainer = document.getElementById('secondary');
  initPokerGrid(pokerChartContainer);
  const evDisplay = document.getElementById('ev-display');
  if (evDisplay) evDisplay.innerHTML = '';

  // Trigger initial equity calculation
  showLoadingOverlay();
  window.electronAPI.runEquity('', '');
  window._lastEquityCalculationDepth = 0;

  // Update flop input field
  const inp = document.getElementById('flop-board');
  if (inp) {
    const suitMapReverse = {'c': '♣', 'd': '♦', 'h': '♥', 's': '♠'};
    const displayFlop =
        explicitFlopBoard
            .map(cardShort => {
              const rank = cardShort[0];       // A, K, Q
              const suitShort = cardShort[1];  // c, d, s
              return rank +
                  (suitMapReverse[suitShort] || suitShort);  // A♣, K♦, Q♠
            })
            .join(', ');
    inp.value = displayFlop;

    document.querySelectorAll('.card.selected')
        .forEach(el => el.classList.remove('selected'));
    explicitFlopBoard.forEach(cardShort => {
      const rank = cardShort[0];
      const suitShort = cardShort[1];
      const cardDisplay = rank + (suitMapReverse[suitShort] || suitShort);
      const el = document.querySelector(`.card[data-card="${cardDisplay}"]`);
      if (el) el.classList.add('selected');
    });
  }
});

const BUCKETS = [
  {label: 'Best hands', lo: 76, hi: 100},
  {label: 'Good hands', lo: 51, hi: 75},
  {label: 'Weak hands', lo: 26, hi: 50},
  {label: 'Trash hands', lo: 0, hi: 25},
];

/**
 * Given a map combo -> EQ, returns an array of
 * { label, pct } for each BUCKET in order.
 */
function computeBucketPercentages(eqMap) {
  const combos = Object.keys(eqMap);
  const total = combos.length;
  return BUCKETS.map(({label, lo, hi}) => {
    const count = combos
                      .filter(cmb => {
                        const pct = eqMap[cmb] ?? 0;
                        return pct >= lo && pct <= hi;
                      })
                      .length;
    return {label, pct: total ? (count / total * 100) : 0};
  });
}

/**
 * Calculates the average strategy distribution for each equity bucket
 * based on the current player's sNode and equity map.
 *
 * @param {object} sNode - The strategy node for the current player.
 * @param {string[]} actions - Array of action labels for the current node.
 * @param {object} equityMap - The equity map for the current player (hero or
 *     villain).
 * @param {Array<object>} bucketsDef - The BUCKETS definition array.
 * @returns {Array<object>} - Array of bucket objects, each containing label and
 *     avgFreqs array.
 */
function computeEquityStrategyDistribution(
    sNode, actions, equityMap, bucketsDef) {
  if (!sNode || !actions || !actions.length || !equityMap || !bucketsDef) {
    return bucketsDef.map(
        b => ({label: b.label, avgFreqs: []}));  // Return empty structure
  }

  const numActions = actions.length;
  const board = boardCardsForCurrentDepth();  // Get relevant board cards

  // Initialize structure to hold summed frequencies and counts per bucket
  const bucketData = bucketsDef.map(b => ({
                                      label: b.label,
                                      lo: b.lo,
                                      hi: b.hi,
                                      freqSums: new Array(numActions).fill(0),
                                      comboCount: 0
                                    }));

  for (const combo in sNode) {
    if (!Object.prototype.hasOwnProperty.call(sNode, combo)) continue;
    if (combo.length !== 4) continue;  // Ensure it's a valid combo string
    if (comboHasBoardCard(combo, board))
      continue;  // Skip combos conflicting with the board

    // Determine equity for this combo
    const flippedCombo = combo.slice(2, 4) + combo.slice(0, 2);
    const equityPercent = equityMap[combo] ?? equityMap[flippedCombo];

    if (equityPercent === undefined || equityPercent === null) {
      continue;
    }

    // Find the bucket this combo belongs to
    const targetBucket =
        bucketData.find(b => equityPercent >= b.lo && equityPercent <= b.hi);

    if (targetBucket) {
      const vecObj = sNode[combo];
      if (typeof vecObj === 'object' && vecObj !== null) {
        const vecArr = Object.keys(vecObj)
                           .sort((a, b) => Number(a) - Number(b))
                           .map(k => vecObj[k]);

        if (vecArr.length >= numActions) {
          targetBucket.comboCount++;
          for (let i = 0; i < numActions; i++) {
            targetBucket.freqSums[i] += (Number(vecArr[i]) || 0);
          }
        } else {
          console.warn(`Invalid frequency vector for combo ${combo}:`, vecArr);
        }
      } else {
        console.warn(`Invalid sNode entry for combo ${combo}:`, vecObj);
      }
    }
  }

  console.log(
      `Inside computeEquityStrategyDistribution: sNode - ${sNode}, actions - ${
          actions}, equityMap - ${equityMap}, bucketData - ${bucketData}`);

  // Calculate average frequencies
  return bucketData.map(b => {
    const avgFreqs = b.comboCount > 0 ?
        b.freqSums.map(sum => sum / b.comboCount) :
        new Array(numActions).fill(0);  // Return zeros if no combos in bucket
    return {label: b.label, avgFreqs};
  });
}

function renderEqBuckets() {
  const phase = getEquityPhase();
  const eqData = window.equityMap[phase] || {};
  const ipBuckets = computeBucketPercentages(eqData.hero || {});
  const oopBuckets = computeBucketPercentages(eqData.villain || {});
  const container = document.getElementById('eq-buckets');
  if (!container) return;
  container.innerHTML = '';

  // ─── Legend ─────────────────────────────────────────────────────────
  const legend = document.createElement('div');
  legend.className = 'eq-legend';
  legend.innerHTML = `
    <div class="label oop"><span class="dot"></span>OOP</div>
    <div class="label ip"><span class="dot"></span>IP</div>
  `;
  container.appendChild(legend);

  BUCKETS.forEach((b, i) => {
    const {label} = b;
    const ipPct = +ipBuckets[i].pct.toFixed(1);
    const oopPct = +oopBuckets[i].pct.toFixed(1);
    const oopHigh = oopPct > ipPct;

    // 1) build the bucket wrapper
    const bucket = document.createElement('div');
    bucket.className = 'eq-bucket';

    // 2) build the title row
    const title = document.createElement('div');
    title.className = 'eq-bucket-title';
    title.innerHTML = `
      <span class="oop">${oopPct}%</span>
      <span>${label}</span>
      <span class="ip">${ipPct}%</span>
    `;
    bucket.appendChild(title);

    // 3) build the bar container
    const bar = document.createElement('div');
    bar.className = 'eq-bar';

    //   a) OOP bar
    const oopBar = document.createElement('div');
    oopBar.classList.add('oop-bar');
    if (oopHigh) oopBar.classList.add('high');
    oopBar.style.position = 'absolute';
    oopBar.style.top = '0';
    oopBar.style.height = '100%';
    oopBar.style.left = `calc(50% - ${oopPct}%)`;
    oopBar.style.width = `${oopPct}%`;
    oopBar.style.backgroundColor = '#e05656';
    oopBar.style.opacity = oopHigh ? '1' : '0.3';
    bar.appendChild(oopBar);

    //   b) IP bar
    const ipBar = document.createElement('div');
    ipBar.classList.add('ip-bar');
    if (!oopHigh) ipBar.classList.add('high');
    ipBar.style.position = 'absolute';
    ipBar.style.top = '0';
    ipBar.style.height = '100%';
    ipBar.style.left = '50%';
    ipBar.style.width = `${ipPct}%`;
    ipBar.style.backgroundColor = '#5acce0';
    ipBar.style.opacity = !oopHigh ? '1' : '0.3';
    bar.appendChild(ipBar);

    bucket.appendChild(bar);
    container.appendChild(bucket);
  });
}

/**
 * Renders the Equity Strategy Distribution chart in its container.
 *
 * @param {Array<object>} strategyDistribution - Data from
 *     computeEquityStrategyDistribution.
 * @param {string[]} actions - Array of action labels for the current node.
 */
function renderEquityStrategyChart(strategyDistribution, actions) {
  const container = document.getElementById('eq-strategy-chart');
  if (!container) return;

  container.innerHTML = '';

  // Handle cases where data is insufficient to render the chart
  if (!strategyDistribution || strategyDistribution.length === 0 || !actions ||
      actions.length === 0) {
    return;
  }
  const numActions = actions.length;

  strategyDistribution.forEach(bucket => {
    const bucketContainer = document.createElement('div');
    bucketContainer.className = 'equity-strategy-bucket';

    const label = document.createElement('span');
    label.className = 'equity-strategy-label';
    label.textContent = bucket.label;
    bucketContainer.appendChild(label);

    const barContainer = document.createElement('div');
    barContainer.className = 'strategy-bar-container';

    let totalFreq = 0;
    bucket.avgFreqs.forEach((freq, index) => {
      if (freq > 0.001) {
        const bar = document.createElement('div');
        bar.className = 'strategy-bar';
        const percentage = freq * 100;
        bar.style.width = `${percentage}%`;
        bar.style.backgroundColor = getColorForAction(actions[index], index);
        // Add text only if the bar is wide enough
        if (percentage > 8) {
          bar.textContent = `${percentage.toFixed(0)}%`;
        }
        barContainer.appendChild(bar);
        totalFreq += freq;
      }
    });

    if (totalFreq < 0.99 && totalFreq > 0) {
      const fillerBar = document.createElement('div');
      fillerBar.className = 'strategy-bar';
      fillerBar.style.width = `${(1 - totalFreq) * 100}%`;
      fillerBar.style.backgroundColor = '#444';  // Dark grey
      barContainer.appendChild(fillerBar);
    }


    bucketContainer.appendChild(barContainer);

    const actionDetailsContainer = document.createElement('div');
    actionDetailsContainer.className = 'action-details';
    actions.forEach((action, index) => {
      const detail = document.createElement('div');
      detail.className = 'action-detail';
      const colorBox = document.createElement('span');
      colorBox.className = 'action-color-box';
      colorBox.style.backgroundColor = getColorForAction(action, index);
      detail.appendChild(colorBox);
      detail.appendChild(document.createTextNode(
          `${action}: ${(bucket.avgFreqs[index] * 100).toFixed(0)}%`));
      actionDetailsContainer.appendChild(detail);
    });
    bucketContainer.appendChild(actionDetailsContainer);


    container.appendChild(bucketContainer);
  });

  const legendContainer = document.createElement('div');
  legendContainer.className = 'action-details';
  legendContainer.style.marginTop = '10px';
  actions.forEach((action, index) => {
    const detail = document.createElement('div');
    detail.className = 'action-detail';
    const colorBox = document.createElement('span');
    colorBox.className = 'action-color-box';
    colorBox.style.backgroundColor = getColorForAction(action, index);
    detail.appendChild(colorBox);
    detail.appendChild(document.createTextNode(action));
    legendContainer.appendChild(detail);
  });
  container.appendChild(legendContainer);
}

// ─── Equity‐Distribution Chart Renderer (interactive) ───────────────
function renderEqDistribution() {
  const container = document.getElementById('eq-dist-container');
  container.innerHTML = '<h4>Equity Distribution</h4>';
  container.classList.remove('fullscreen');

  // ─── add expand & close buttons ────────────────────────────────
  const expandBtn = document.createElement('button');
  expandBtn.className = 'expand-btn';
  expandBtn.textContent = '\u26F6';  // ◶
  container.appendChild(expandBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = 'Close';
  closeBtn.style.display = 'none';
  container.appendChild(closeBtn);

  // ─── create canvas ───────────────────────────────────
  const CSS_W = 500, CSS_H = 250;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.id = 'eq-dist-chart';
  canvas.style.width = CSS_W + 'px';
  canvas.style.height = CSS_H + 'px';
  canvas.width = CSS_W * dpr;
  canvas.height = CSS_H * dpr;
  canvas.style.cursor = 'crosshair';
  container.appendChild(canvas);

  // ─── Legend Overlay ────────────────────────────────────────────────
  const legend = document.createElement('div');
  legend.className = 'eq-dist-legend';
  legend.innerHTML = `
      <span class="legend-item">
        <span class="color-box ip"></span>IP
      </span>
      <span class="legend-item">
        <span class="color-box oop"></span>OOP
      </span>
    `;
  container.appendChild(legend);

  // ─── tooltip ───────────────────────────────────────────────────
  let tooltip = document.getElementById('eq-dist-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'eq-dist-tooltip';
    Object.assign(tooltip.style, {
      position: 'absolute',
      pointerEvents: 'none',
      padding: '6px 10px',
      background: '#222',
      color: '#eee',
      border: '1px solid #444',
      borderRadius: '4px',
      fontSize: '0.85rem',
      fontFamily: 'Inter, sans-serif',
      display: 'none',
      zIndex: 10,
      whiteSpace: 'nowrap',
    });
    container.appendChild(tooltip);
  }

  // ─── Add note about non-weighted equities ───────────────────────
  let equityNote = document.getElementById('equity-accuracy-note');
  if (!equityNote) {
    equityNote = document.createElement('p');
    equityNote.id = 'equity-accuracy-note';
    equityNote.textContent =
        'Note: Equity calculations do not consider hand frequencies and may be inaccurate.';
    Object.assign(equityNote.style, {
      fontStyle: 'italic',
      fontSize: '0.8rem',
      color: '#aaa',
      marginTop: '8px',
      textAlign: 'center',
    });
    container.appendChild(equityNote);
  }

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // ─── prepare data ──────────────────────────────────────────────
  const phase = getEquityPhase();
  const eqData = window.equityMap[phase] || {};
  const ipPairs = Object.entries(eqData.hero || {})
                      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const oopPairs = Object.entries(eqData.villain || {})
                       .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

  const ipData = ipPairs.map(([, eq]) => eq);
  const oopData = oopPairs.map(([, eq]) => eq);
  const ipCount = ipData.length;
  const oopCount = oopData.length;

  const M = {top: 20, left: 50, right: 20, bottom: 30};
  let curW = CSS_W, curH = CSS_H;

  // ─── static draw helper ────────────────────────────────────────
  function drawStatic() {
    const W = curW - M.left - M.right;
    const H = curH - M.top - M.bottom;

    // axes
    ctx.clearRect(0, 0, curW, curH);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.left, M.top);
    ctx.lineTo(M.left, M.top + H);
    ctx.lineTo(M.left + W, M.top + H);
    ctx.stroke();

    // ticks
    ctx.fillStyle = '#aaa';
    ctx.font = '10px Inter';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = M.top + H * (1 - i / 4);
      ctx.beginPath();
      ctx.moveTo(M.left - 5, y);
      ctx.lineTo(M.left, y);
      ctx.stroke();
      ctx.fillText((i * 25) + '%', M.left - 8, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 5; i++) {
      const x = M.left + W * (i / 5);
      ctx.beginPath();
      ctx.moveTo(x, M.top + H);
      ctx.lineTo(x, M.top + H + 5);
      ctx.stroke();
      ctx.fillText((i * 20) + '%', x, M.top + H + 8);
    }

    // curves
    function plotLine(data, color, count) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      data.forEach((v, i) => {
        const x = M.left + W * (i / (count - 1));
        const y = M.top + H * (1 - v / 100);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    plotLine(ipData, '#5acce0', ipCount);    // IP blue
    plotLine(oopData, '#e05656', oopCount);  // OOP red
  }

  // initial draw
  drawStatic();

  // ─── resize helper ─────────────────────────────────────────────
  function doResize(newW, newH) {
    curW = newW;
    curH = newH;
    canvas.style.width = curW + 'px';
    canvas.style.height = curH + 'px';
    canvas.width = curW * dpr;
    canvas.height = curH * dpr;
    ctx.scale(dpr, dpr);
    drawStatic();
  }

  // ─── expand / close handlers ───────────────────────────────────
  expandBtn.addEventListener('click', () => {
    container.classList.add('fullscreen');
    expandBtn.style.display = 'none';
    closeBtn.style.display = 'block';
    doResize(window.innerWidth, 2 * CSS_H);
  });
  closeBtn.addEventListener('click', () => {
    container.classList.remove('fullscreen');
    closeBtn.style.display = 'none';
    expandBtn.style.display = 'block';
    doResize(CSS_W, CSS_H);
  });

  // ─── mouse interaction ─────────────────────────────────────────
  function drawCursor(mx) {
    drawStatic();
    const W = curW - M.left - M.right, H = curH - M.top - M.bottom;
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(mx, M.top);
    ctx.lineTo(mx, M.top + H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  canvas.addEventListener('mouseenter', () => tooltip.style.display = 'block');
  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    drawStatic();
  });
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const W = curW - M.left - M.right;
    if (mx < M.left || mx > M.left + W) return;

    drawCursor(mx);

    const frac = (mx - M.left) / W;
    const ipIdx = Math.round(frac * (ipCount - 1));
    const oopIdx = Math.round(frac * (oopCount - 1));

    // clamp to valid range
    const [ipCmb, ipEq] =
        ipPairs[Math.max(0, Math.min(ipIdx, ipCount - 1))] || [];
    const [oopCmb, oopEq] =
        oopPairs[Math.max(0, Math.min(oopIdx, oopCount - 1))] || [];

    tooltip.innerHTML = `
      <div class="ip">${formatCombo(ipCmb)} ${ipEq?.toFixed(2) || '--'}%</div>
      <div class="oop">${formatCombo(oopCmb)} ${
        oopEq?.toFixed(2) || '--'}%</div>
    `;

    let tx = mx + 12, ty = e.clientY - rect.top + 12;
    if (tx + tooltip.offsetWidth > curW) tx = mx - tooltip.offsetWidth - 12;
    if (ty + tooltip.offsetHeight > curH) ty = curH - tooltip.offsetHeight - 4;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  });
}


/**
 * Recursively creates a collapsible tree view from a JSON object or array.
 * (Only keys "c" and "d" are preserved; others are omitted.)
 *
 * @param {any} data - The JSON data to display.
 * @param {HTMLElement} parentElem - The container element where the tree view
 *     is appended.
 * @param {object} options - (Optional) Rendering options.
 */
function createTreeView(data, parentElem, options = {}) {
  // Reset the global chance node counter at the root.
  if (parentElem === document.getElementById('json-viewer')) {
    window._chanceNodeRenderCount = 0;
  }
  const ul = document.createElement('ul');
  ul.style.listStyle = 'none';
  ul.style.paddingLeft = '1em';
  ul.style.margin = '0';

  if (typeof data === 'object' && data !== null) {
    if (Array.isArray(data)) {
      data.forEach((item, index) => {
        const li = document.createElement('li');
        renderNode(li, index, item, data, options);  // Pass options along.
        ul.appendChild(li);
      });
    } else {
      let keys;
      // For a nodes: if there is an explicit "c" property, use that.
      // Otherwise, fall back to all object keys except a set of reserved ones.
      if (data.t === 'a') {
        if (data.hasOwnProperty('c')) {
          keys = ['c'];
        } else {
          // These keys are considered metadata and should not be rendered as
          // children.
          const reservedKeys = ['t', 'p', 'a', 's'];
          keys = Object.keys(data).filter(key => !reservedKeys.includes(key));
        }
      } else if (data.t === 'ch') {
        keys = data.hasOwnProperty('d') ? ['d'] : [];
      } else {
        keys = Object.keys(data);
      }

      keys.forEach(key => {
        const li = document.createElement('li');
        renderNode(li, key, data[key], data, options);
        ul.appendChild(li);
      });
    }
  } else {
    const li = document.createElement('li');
    li.textContent = data;
    ul.appendChild(li);
  }
  parentElem.appendChild(ul);
}


/**
 * Transforms a given key to title case and optionally rounds numeric
 * substrings.
 *
 * @param {string} key - The original key text.
 * @param {boolean} noRounding - Whether to skip rounding.
 * @returns {string} - The transformed key.
 */
function transformKey(key, noRounding = false) {
  if (!noRounding) {
    key = key.replace(/(\d+(\.\d+)?)/g, function(match) {
      return parseFloat(match).toFixed(2);
    });
  }
  return key.split(/[\s_-]+/)
      .map(word => {
        if (word.length === 0) return word;
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ');
}


// full‑screen loading overlay
function showLoadingOverlay() {
  let ov = document.getElementById('loading-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'loading-overlay';
    Object.assign(ov.style, {
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10000,
      color: '#fff',
      fontFamily: 'sans-serif',
      padding: '1em',
      boxSizing: 'border-box',
    });

    const title = document.createElement('div');
    title.textContent = 'Running…';
    title.style.fontSize = '1.5em';
    ov.appendChild(title);

    const msgContainer = document.createElement('div');
    msgContainer.id = 'loading-messages';
    Object.assign(msgContainer.style, {
      marginTop: '1em',
      width: '80%',
      maxHeight: '50vh',
      overflowY: 'auto',
      textAlign: 'left',
      fontSize: '1em',
    });
    ov.appendChild(msgContainer);

    document.body.appendChild(ov);
  }
  // clear old messages
  const msgContainer = document.getElementById('loading-messages');
  if (msgContainer) msgContainer.innerHTML = '';
  ov.style.display = 'flex';
}

function hideLoadingOverlay() {
  const ov = document.getElementById('loading-overlay');
  if (ov) ov.style.display = 'none';
}

// Listen for progress updates from the main process.
window.electronAPI.onProgressUpdate((event, message) => {
  // footer update
  const footer = document.getElementById('footer');
  const p1 = document.createElement('div');
  p1.textContent = message;
  footer.appendChild(p1);
  while (footer.children.length > 2) footer.removeChild(footer.firstChild);

  // live overlay update
  const msgContainer = document.getElementById('loading-messages');
  if (msgContainer &&
      document.getElementById('loading-overlay').style.display !== 'none') {
    const p2 = document.createElement('div');
    p2.textContent = message;
    msgContainer.appendChild(p2);
    // keep only the last 2 lines in the overlay
    while (msgContainer.children.length > 2) {
      msgContainer.removeChild(msgContainer.firstChild);
    }
    // scroll to bottom
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }
});

/**
 * Renders a single node (key-value pair) in the tree view.
 * Handles expand/collapse, lazy loading, and specific rendering for different
 * keys/types.
 *
 * @param {HTMLElement} li - The list item element to populate.
 * @param {string|number} key - The property key or array index.
 * @param {any} value - The value associated with the key (can be null for
 *     lazy-loaded nodes).
 * @param {object} parentData - The data object of the parent node.
 * @param {object} options - Rendering options (e.g., path, actions,
 *     noRounding).
 */
function renderNode(li, key, value, parentData, options = {}) {
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.classList.add('json-node');
  const currentPath = options.path || '';
  // Construct the path for the current node
  container.dataset.path = currentPath ? `${currentPath}.${key}` : `${key}`;

  const keyLabel = document.createElement('span');
  keyLabel.style.marginRight = '0.5em';

  let displayKey = '';
  // Determine the display label based on the key and parent context
  if (key === 'c') {
    // If parent has player info 'p', label based on player; otherwise, generic
    // 'Children'
    if (parentData && Object.prototype.hasOwnProperty.call(parentData, 'p')) {
      displayKey =
          parentData.p === 1 ? 'Out-of-Position Player' : 'In-Position Player';
    } else {
      displayKey = 'Children';
    }
  } else if (key === 'd') {
    displayKey = 'Deal';  // Specific label for chance node outcomes
  } else if (typeof key === 'number' || /^\d+$/.test(key)) {
    // If key is numeric (array index), try to use action labels from options if
    // available
    if (options.actions && Array.isArray(options.actions) &&
        key < options.actions.length) {
      displayKey = options.actions[Number(key)];
    } else {
      displayKey = key;  // Fallback to index if actions aren't available/match
    }
  } else {
    // General case: transform key text (e.g., capitalize, round numbers)
    displayKey = transformKey(key, false);
  }
  keyLabel.textContent = displayKey + ':';
  container.appendChild(keyLabel);

  // Find this block in renderer.js (around line 420)
  if (key === 'd') {
    if (typeof window._chanceNodeRenderCount === 'undefined') {
      window._chanceNodeRenderCount = 0;
    }
    window._chanceNodeRenderCount++;
    const currentChanceDepth =
        window._chanceNodeRenderCount;  // Capture depth for this node

    let selectedCard = '';
    // Determine which card to display based on chance node depth and dropdowns
    if (currentChanceDepth === 1) {  // Turn node
      const turnSelect = document.getElementById('turn-dropdown');
      if (turnSelect) {
        selectedCard =
            turnSelect.value || '';  // Default to empty string if not selected
      }
    } else if (currentChanceDepth === 2) {  // River node
      const riverSelect = document.getElementById('river-dropdown');
      if (riverSelect) {
        selectedCard =
            riverSelect.value || '';  // Default to empty string if not selected
      }
    } else {
      // Handle potential deeper chance nodes if the structure allows, or ignore
      console.warn(
          `[renderNode Deal] Encountered unexpected chance node depth: ${
              currentChanceDepth}`);
    }

    // Set the correct path for the 'd' node container itself
    // container.dataset.path was already set earlier in renderNode for the
    // parent 'li' The path we need is the path to the 'd' node itself.
    const dNodePath = container.dataset.path;  // Path like 'c.0.c.0.d'

    li.appendChild(container);  // Append the "Deal:" label container first

    const cardChildrenContainer = document.createElement('div');
    cardChildrenContainer.style.paddingLeft =
        '1em';  // Indent children visually
    li.appendChild(
        cardChildrenContainer);  // Append container for card-specific children

    // Auto-select if only one card outcome exists in the initially fetched 'd'
    // node data
    const availableKeys =
        (typeof value === 'object' && value !== null) ? Object.keys(value) : [];
    if (!selectedCard && availableKeys.length === 1) {
      console.log(`[renderNode Deal] Auto-selecting the only available card: ${
          availableKeys[0]}`);
      selectedCard = availableKeys[0];
    }

    if (selectedCard) {
      const fullCardPath =
          `${dNodePath}.${selectedCard}`;  // Construct path like 'c.0.c.0.d.3c'
      console.log(`[renderNode Deal] Selected card is "${
          selectedCard}". Requesting subtree for path: "${fullCardPath}"`);

      cardChildrenContainer.textContent =
          `Loading ${selectedCard}...`;  // Placeholder
      cardChildrenContainer.style.fontStyle = 'italic';
      cardChildrenContainer.style.color = '#888';

      window.electronAPI.getSubtree(fullCardPath)
          .then(res => {
            cardChildrenContainer.innerHTML = '';  // Clear placeholder
            cardChildrenContainer.style.fontStyle = 'normal';
            cardChildrenContainer.style.color = 'inherit';

            if (res.ok && res.data !== null &&
                typeof res.data !== 'undefined') {
              console.log(
                  `[renderNode Deal] Successfully fetched data for card path "${
                      fullCardPath}". Rendering children.`);
              // Render the tree view for the fetched data
              createTreeView(res.data, cardChildrenContainer, {
                ...options,          // Pass existing options
                path: fullCardPath,  // The path of the node we just fetched
              });

            } else {
              console.error(
                  `[renderNode Deal] Failed to fetch or received empty data for card path "${
                      fullCardPath}". Error: ${res.error}`);
              cardChildrenContainer.textContent = `Error loading data for ${
                  selectedCard}. ${res.error || '(Branch might not exist)'}`;
              cardChildrenContainer.style.color = 'red';
            }
          })
          .catch(fetchErr => {
            console.error(
                `[renderNode Deal] Unhandled error during getSubtree call for card path "${
                    fullCardPath}":`,
                fetchErr);
            cardChildrenContainer.innerHTML = '';  // Clear placeholder
            cardChildrenContainer.textContent =
                `Error initiating data load for ${selectedCard}.`;
            cardChildrenContainer.style.color = 'red';
          });

    } else {
      // Display a notice if no card is selected (and not auto-selected)
      const notice = document.createElement('span');
      notice.style.fontStyle = 'italic';
      notice.style.color = '#555';
      notice.textContent = ' (No card selected in dropdown)';
      // Append notice directly inside the children container
      cardChildrenContainer.appendChild(notice);
    }

    return;
  }

  // Handle objects recursively OR nodes known to be expandable even if data is
  // initially null
  const isPotentiallyExpandable =
      (key === 'c' || key === 'd' || typeof key === 'number');

  if ((typeof value === 'object' && value !== null) ||
      (value === null && isPotentiallyExpandable)) { 
    // Add expander if it's an object OR if it's null but known to be expandable
    // (lazy-load target)
    const expander = document.createElement('span');
    expander.textContent = '▶';
    expander.style.cursor = 'pointer';
    expander.style.marginRight = '0.5em';
    container.insertBefore(expander, keyLabel);

    li.appendChild(container);  // Append container (key + expander)

    const childrenContainer = document.createElement('div');
    childrenContainer.style.display = 'none';
    childrenContainer.style.paddingLeft = '1em';

    expander.addEventListener('click', () => {
      const currentContainer = container;  // Capture container for correct path
                                           // lookup inside callback
      const currentPath =
          currentContainer.dataset.path;  // Get path from the container clicked

      if (childrenContainer.style.display === 'none') {  // Expanding
        // Collapse previous, expand current
        if (window._lastExpandedContainer) {
          window._lastExpandedContainer.classList.remove('json-node-expanded');
        }
        childrenContainer.style.display = 'block';
        expander.textContent = '▼';
        currentContainer.classList.add('json-node-expanded');
        window._lastExpandedContainer = currentContainer;

        // Check if children are already rendered OR if data is already
        // available
        if (childrenContainer.childElementCount > 0) {
          console.log(`[renderNode click] Children for path "${
              currentPath}" already rendered.`);
          return;  // Already rendered, do nothing more
        }

        // Check if the 'value' passed *initially* to this renderNode call is
        // already populated This applies after the root node reconstruction in
        // SQLZ.init It also applies if a node was fetched previously via
        // subtree
        if (value !== null && typeof value === 'object') {
          console.log(`[renderNode click] Data for path "${
              currentPath}" already available in initial 'value'. Rendering children directly.`);

          // Prepare options, ensuring parent's actions are passed down
          // Use parentData which is the 3rd argument of renderNode, captured by
          // the closure
          const childOptions = {
            ...options,
            actions: parentData?.a,  // Use parent's actions if available
            path: currentPath
          };
          childrenContainer.innerHTML = '';  // Clear just in case
          createTreeView(
              value, childrenContainer,
              childOptions);  // Render using the existing value

          // Trigger post-expansion updates (like charts) if needed
          // Need 'key' which is also captured by the closure
          triggerPostExpansionUpdates(
              currentPath, key, parentData, value, options);

        } else if (value === null) {
          childrenContainer.textContent = 'Loading...';  // Placeholder
          childrenContainer.style.fontStyle = 'italic';
          childrenContainer.style.color = '#888';
          window.electronAPI.getSubtree(currentPath)
              .then(res => {
                childrenContainer.innerHTML = '';
                childrenContainer.style.fontStyle = 'normal';
                childrenContainer.style.color = 'inherit';
                if (res.ok) {
                  const fetchedValue = res.data;
                  // Prepare options (needs parentData correctly passed)
                  const childOptions = {
                    ...options,
                    actions: parentData?.a,  // Use parent's actions
                    path: currentPath
                  };
                  childrenContainer.innerHTML = '';  // Clear loading/error
                  if (fetchedValue !== null &&
                      typeof fetchedValue !== 'undefined') {
                    createTreeView(
                        fetchedValue, childrenContainer, childOptions);
                    // Trigger post-expansion updates
                    triggerPostExpansionUpdates(
                        currentPath, key, parentData, fetchedValue, options);
                  } else {
                    console.error(
                        `[renderNode click] Fetched null or undefined data for path "${
                            currentPath}" from getSubtree.`);
                    childrenContainer.textContent =
                        'Error: Received empty data.';
                  }
                } else {
                  console.error(
                      `[renderNode click] Subtree fetch error for path "${
                          currentPath}":`,
                      res.error);
                  childrenContainer.textContent = 'Error loading data.';
                }
              })
              .catch(fetchErr => {
                childrenContainer.innerHTML = '';
                childrenContainer.style.fontStyle = 'normal';
                childrenContainer.style.color = 'inherit';
                console.error(
                    `[renderNode click] Unhandled error during getSubtree call for path "${
                        currentPath}":`,
                    fetchErr);
                childrenContainer.textContent = 'Error initiating data load.';
              });
        } else {
          // This case should not happen for expandable nodes
          console.warn(
              `[renderNode click] Unexpected initial value type for expandable node "${
                  currentPath}":`,
              value);
          childrenContainer.textContent = 'Cannot expand node.';
        }

      } else {  // Collapsing
        childrenContainer.style.display = 'none';
        expander.textContent = '▶';
        currentContainer.classList.remove('json-node-expanded');
        if (currentContainer === window._lastExpandedContainer) {
          window._lastExpandedContainer = null;
        }
      }
    });

    li.appendChild(childrenContainer);

  } else {  // Handles non-object, non-null, non-expandable-null values
    const valueSpan = document.createElement('span');
    let displayValue = value;
    // Format non-object values (number, string, boolean, explicit
    // null/undefined)
    if (typeof value === 'number' && !options.noRounding) {
      displayValue = Number(value).toFixed(2);
    } else if (value === null) {  // Display actual null only if it wasn't an
                                  // expandable case
      displayValue = 'null';
    } else if (typeof value === 'undefined') {
      displayValue = 'undefined';
    }
    // Append the formatted value after the key label
    valueSpan.textContent =
        ' ' + String(displayValue);  // Ensure string conversion
    container.appendChild(valueSpan);
    li.appendChild(container);  // Append the container with key and value
  }
}

async function triggerPostExpansionUpdates(
    actionNodePath,  // Path of the node represented by parentData
    key, parentData, nodeData, options) {
  const logPrefix = `[triggerPostExpansionUpdates path="${actionNodePath}"]`;
  console.log(`${logPrefix} START`);
  console.log(`ParentData type: ${typeof parentData}`, parentData);

  // Only proceed if parentData is potentially the relevant Action Node
  if (!parentData || typeof parentData !== 'object' || parentData.t !== 'a') {
    console.log(`${
        logPrefix} parentData is not an action node (or is null). Skipping chart/equity updates.`);
    return;
  }

  console.log(`${logPrefix} Parent data IS an action node.`);
  const initialSNodeData = findsNode(parentData);

  function updateGlobalsAndCharts(actionNode) {
    const finalSNodeData = findsNode(actionNode);
    const finalActions = actionNode.a || [];
    console.log(`${logPrefix} Updating charts with Action Node:`, actionNode);
    console.log(`${logPrefix} Extracted final sNodeData:`, finalSNodeData);
    console.log(`${logPrefix} Extracted final actions:`, finalActions);
    window.currentPlayer = actionNode.p;
    window.currentSNode = finalSNodeData;
    window.currentActions = finalActions;
    console.log(`${logPrefix} Extracted final player:`, window.currentPlayer);
    if (finalSNodeData) {
      console.log(
          `${logPrefix} Found final strategy data. Calling applyToChart...`);
      applyToChart(finalSNodeData, finalActions);
    } else {
      console.log(`${
          logPrefix} No .s.s node found even after potential reconstruction. Clearing strategy charts.`);
      window.currentSNode = null;
      window.currentActions = [];
      applyToChart({}, []);
      const evDisplay = document.getElementById('ev-display');
      if (evDisplay)
        evDisplay.innerHTML =
            '<h4>Strategy</h4><div>No strategy data available for this node.</div>';
      renderEquityStrategyChart([], []);
    }
    window.currentDepth = window._chanceNodeRenderCount;
    handleEquityUpdateCheck();
  }

  if (initialSNodeData) {
    console.log(
        `${logPrefix} Initial sNodeData found. Updating charts directly.`);
    updateGlobalsAndCharts(parentData);
  } else {
    const parentPath = actionNodePath.substring(
        0, actionNodePath.lastIndexOf('.'));  // Infer parent path
    // Strategy data MISSING. Trigger reconstruction using actionNodePath
    console.warn(
        `${logPrefix} Initial sNodeData is null in parentData for path ${
            actionNodePath}. Triggering getSubtree for parent path "${
            parentPath}" to reconstruct...`);
    try {
      applyToChart({}, []);
      renderEquityStrategyChart([], []);
      const evDisplay = document.getElementById('ev-display');
      if (evDisplay)
        evDisplay.innerHTML = '<h4>Strategy</h4><div>Loading strategy...</div>';

      const res =
          await window.electronAPI.getSubtree(parentPath);
      console.log(
          `${logPrefix} Received response from getSubtree("${
              actionNodePath}"):`,
          res);  // Log with correct path
      if (res && res.data) {
        console.log(`${logPrefix} res.data type: ${
            typeof res.data}, res.data.t: ${res.data?.t}`);
      }


      if (res.ok && res.data && res.data.t === 'a') {
        console.log(`${logPrefix} Reconstruction of parent \"${
            parentPath}\" successful. Updating charts with its data.`);
        updateGlobalsAndCharts(res.data);
      } else {
        console.error(
            `${logPrefix} Failed to reconstruct parent \"${
                parentPath}\" or received invalid/non-action data. OK: ${
                res.ok}, Error: ${res.error}`,
            res.data);  // Use parent path in log window.currentSNode = null;
        window.currentActions = [];
        applyToChart({}, []);
        if (evDisplay)
          evDisplay.innerHTML =
              '<h4>Strategy</h4><div>Error loading strategy data.</div>';
        renderEquityStrategyChart([], []);
      }
    } catch (reconstructErr) {
      console.error(
          `${logPrefix} Error during getSubtree call for reconstruction of parent \"${
              parentPath}\":`,
          reconstructErr);  // Use parent path in log window.currentSNode =
                            // null;
      window.currentActions = [];
      applyToChart({}, []);
      const evDisplay = document.getElementById('ev-display');
      if (evDisplay)
        evDisplay.innerHTML =
            '<h4>Strategy</h4><div>Error loading strategy data.</div>';
      renderEquityStrategyChart([], []);
    }
  }
}

function handleEquityUpdateCheck() {
  const logPrefix = `[handleEquityUpdateCheck]`;
  if (!window._isSolutionLoaded) {
    console.log(`${logPrefix} Solution not loaded, skipping equity check.`);
    return;
  }
  if (!window._hasComputedInitialEquities) { 
    console.warn(`${logPrefix} Initial equities flag not set yet.`);
    return;
  }

  try {
    const currentRequiredDepth =
        window.currentDepth;         // 0=Flop, 1=Turn, 2=River
    const phase = getEquityPhase();  // flop, turn, river

    // Check if equity for the *current* street needs recalculation/fetch
    // Compare current depth with the last depth calculated
    if (currentRequiredDepth > window._lastEquityCalculationDepth &&
        currentRequiredDepth <= 2) {
      const turnSel = document.getElementById('turn-dropdown');
      const riverSel = document.getElementById('river-dropdown');
      const turn = currentRequiredDepth >= 1 ? (turnSel?.value || '') : '';
      const river = currentRequiredDepth >= 2 ? (riverSel?.value || '') : '';

      // Prevent triggering if necessary dropdown isn't selected yet
      if (currentRequiredDepth === 1 && !turn) {
        console.log(`${
            logPrefix} Reached Turn depth, but no Turn card selected. Skipping equity run.`);
        return;
      }
      if (currentRequiredDepth === 2 && !river) {
        console.log(`${
            logPrefix} Reached River depth, but no River card selected. Skipping equity run.`);
        return;
      }

      console.log(`${logPrefix} New street detected (Depth ${
          currentRequiredDepth}). Running equity for Turn: ${
          turn || 'N/A'}, River: ${river || 'N/A'}`);
      showLoadingOverlay();  // Show loading for equity calc
      window._lastEquityCalculationDepth =
          currentRequiredDepth;  // Update depth marker BEFORE async call to
                                 // prevent re-triggering
      window.electronAPI.runEquity(turn, river).catch(err => {
        console.error(`${logPrefix} runEquity failed:`, err);
        hideLoadingOverlay();  // Ensure hidden on error
      });
    } else {
      // Equity for this street presumably loaded, ensure charts using it are
      // re-rendered
      console.log(
          `${logPrefix} Re-rendering equity charts for current street (Depth ${
              currentRequiredDepth}, Phase ${phase}).`);
      const eqData = window.equityMap[phase] || {};
      const playerEquityMap = window.currentPlayer === 0 ?
          (eqData?.hero || {}) :
          (eqData?.villain || {});

      if (window.currentSNode && window.currentActions) {
        const strategyDistribution = computeEquityStrategyDistribution(
            window.currentSNode, window.currentActions, playerEquityMap,
            BUCKETS);
        renderEquityStrategyChart(strategyDistribution, window.currentActions);
      } else {
        renderEquityStrategyChart([], []);
      }
      renderEqBuckets();
      renderEqDistribution();
    }
  } catch (err) {
    console.error(`${logPrefix} Error during equity check/render:`, err);
    hideLoadingOverlay();  // Ensure loading is hidden if error occurs
  }
}

/**
 * Tries to locate a nested s node at parentData.s.s.
 */
function findsNode(parentData) {
  if (!parentData || typeof parentData !== 'object') return null;
  if (!parentData.s) return null;
  const s = parentData.s;
  if (s.s && typeof s.s === 'object') {
    return s.s;
  }
  return null;
}

/**
 * Traverses only the "CHECK" branch of the solution tree to extract card
 * choices from ch nodes. The expected path is: c -> CHECK ->
 * c -> CHECK -> d -> [chosen card] -> c -> CHECK -> ...
 * When a chance node is encountered:
 *   - The first chance node's d keys are taken as turn cards.
 *   - The second chance node is processed only if its dn is not 0;
 *     otherwise it is ignored (making the solution turn-only).
 *
 * @param {object} node - The JSON solution tree.
 * @returns {object} - An object with properties "turnCards" and "riverCards"
 *     (arrays).
 */
function extractCardChoices(node) {
  let turnCards = [];
  let riverCards = [];
  let chanceCount = 0;
  let current = node;

  while (current) {
    // If the current node is a chance node with d, process it.
    if (current.t === 'ch' && current.d && typeof current.d === 'object') {
      chanceCount++;
      if (chanceCount === 1) {
        turnCards = Object.keys(current.d);
        // Arbitrarily choose the first card branch to continue the CHECK path.
        const chosenCard = turnCards[0];
        if (current.d.hasOwnProperty(chosenCard)) {
          current = current.d[chosenCard];
          continue;
        } else {
          break;
        }
      } else if (chanceCount === 2) {
        // Check if this second chance node should be ignored.
        if (current.d && typeof current.d === 'object' &&
            Object.keys(current.d).length > 0) {
          const firstKey = Object.keys(current.d)[0];
          if (current.d[firstKey] === null) {
            break;
          }
        } else {
          riverCards = Object.keys(current.d);
          const chosenCard = riverCards[0];
          if (current.d.hasOwnProperty(chosenCard)) {
            current = current.d[chosenCard];
            continue;
          } else {
            break;
          }
        }
      } else {
        // More than two chance nodes: stop processing.
        break;
      }
    } else if (current.hasOwnProperty('c') && Array.isArray(current.c)) {
      // Follow the "CHECK" branch:
      if (current.hasOwnProperty('a') && Array.isArray(current.a)) {
        const checkIndex =
            current.a.findIndex(act => act.toLowerCase() === 'check');
        if (checkIndex >= 0 && current.c.length > checkIndex) {
          current = current.c[checkIndex];
          continue;
        } else {
          break;
        }
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return {turnCards, riverCards};
}


/**
 * Filters the solution tree based on dropdown selections while following
 * only the "CHECK" path. Instead of using a global counter, it passes the
 * current chance node depth as a parameter so that the branch filtering applies
 * only to the current branch. This ensures that when a user selects a turn (or
 * river) card, the full branch is preserved.
 *
 * @param {object} node - The original solution tree.
 * @param {string} turnSelection - The selected card for the turn.
 * @param {string} riverSelection - The selected card for the river.
 * @returns {object} - The filtered tree.
 */
function filterSolutionTree(node, turnSelection, riverSelection) {
  // Recursive helper that takes the current chance node depth.
  function filterNode(n, chanceDepth) {
    if (typeof n !== 'object' || n === null) return n;
    if (Array.isArray(n)) return n.map(item => filterNode(item, chanceDepth));

    let result = {};

    // Handle chance nodes (abbreviated: t === 'ch', outcomes in "d").
    if (n.t === 'ch' && n.d && typeof n.d === 'object') {
      const newChanceDepth = chanceDepth + 1;
      if (newChanceDepth === 1 && turnSelection &&
          n.d.hasOwnProperty(turnSelection)) {
        result.d = {};
        result.d[turnSelection] =
            filterNode(n.d[turnSelection], newChanceDepth);
      } else if (newChanceDepth === 2) {
        // Check if the first element of "d" is null.
        const dKeys = Object.keys(n.d);
        if (dKeys.length > 0 && n.d[dKeys[0]] === null) {
          result.d = {};
        } else if (riverSelection && n.d.hasOwnProperty(riverSelection)) {
          result.d = {};
          result.d[riverSelection] =
              filterNode(n.d[riverSelection], newChanceDepth);
        } else {
          result.d = {};
        }
      } else {
        result.d = {};
      }
    }
    // Handle action nodes (t === 'a') with children in "c" and actions in "a".
    else if (
        n.t === 'a' && n.c && Array.isArray(n.c) && n.a && Array.isArray(n.a)) {
      // Look for the CHECK branch: compare the first character of each action.
      const checkIndex = n.a.findIndex(act => act[0].toLowerCase() === 'check');
      if (checkIndex >= 0 && n.c.length > checkIndex) {
        result.c = filterNode(n.c[checkIndex], chanceDepth);
      } else {
        // If no CHECK branch is found, process all children.
        result.c = n.c.map(child => filterNode(child, chanceDepth));
      }
    }

    // Process all other keys normally.
    for (let key in n) {
      if (n.hasOwnProperty(key)) {
        // Skip raw keys already handled in chance ('d') and action ('c') nodes.
        if ((key === 'd' && n.t === 'ch') || (key === 'c' && n.t === 'a'))
          continue;
        result[key] = filterNode(n[key], chanceDepth);
      }
    }
    return result;
  }
  return filterNode(node, 0);
}

/**
 * Creates or updates the dropdown menus with available card choices based on
 * the full deck and board cards. Uses an explicitly provided flop board for
 * initial population, ensuring consistency when loading. Determines solution
 * depth by checking the original tree structure but always displays both
 * dropdowns.
 *
 * @param {object} solutionTree - The JSON solution tree (used only to determine
 * solution depth initially).
 * @param {string[]} explicitFlopBoard - The flop board array (e.g., ["Ac",
 * "Kd", "Qs"]) associated with this tree.
 */
function updateDropdowns(
    solutionTree,
    explicitFlopBoard = []) {  // Added explicitFlopBoard parameter
  // Determine solution depth from the tree structure (still useful for other
  // logic maybe)
  const {riverCards} =
      extractCardChoices(solutionTree);  // Still need this for depth check
  window.solutionDepth = (riverCards && riverCards.length > 0) ? 2 : 1;

  // Use the explicitly passed flop board for initial calculations
  const flopBoard = explicitFlopBoard;  // ["Ac", "Kd", "Qs"] format

  // Utility for sorting cards by rank then suit
  const rankOrder =
      ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  function sortCards(cards) {
    return cards.slice().sort((x, y) => {
      const [rX, sX] = [x[0], x[1]];
      const [rY, sY] = [y[0], y[1]];
      const dr = rankOrder.indexOf(rX) - rankOrder.indexOf(rY);
      return dr !== 0 ? dr : sX.localeCompare(sY);
    });
  }

  // --- Turn Dropdown ---
  let turnSelect = document.getElementById('turn-dropdown');
  if (!turnSelect) {
    turnSelect = document.createElement('select');
    turnSelect.id = 'turn-dropdown';
    const turnLabel = document.createElement('label');
    turnLabel.innerText = 'Turn Card: ';
    const container = document.createElement('div');
    container.style.display = 'inline-block';
    container.style.marginRight = '20px';
    container.appendChild(turnLabel);
    container.appendChild(turnSelect);
    const leftCol = document.getElementById('yui-main');
    leftCol.insertBefore(container, leftCol.firstChild);

    // Add event listener only once during creation
    turnSelect.addEventListener('change', (event) => {
      window.currentDepth = 0;
      window._lastEquityCalculationDepth = 0;
      populateRiverDropdown();  // Update river options based on new turn card
                                // (reads current board)
      updateTreeViewWithSelections(solutionTree);  // Uses current selections
      renderEqBuckets();
      renderEqDistribution();
      applyToChart(window.currentSNode, window.currentActions);
      // showLoadingOverlay();
      // window.electronAPI.runEquity('', '');  // Recalculates flop equity
    });
  }

  // --- River Dropdown ---
  let riverSelect = document.getElementById('river-dropdown');
  let riverContainer = document.getElementById('river-dropdown-container');
  if (!riverSelect) {
    riverSelect = document.createElement('select');
    riverSelect.id = 'river-dropdown';

    // Add event listener only once during creation
    riverSelect.addEventListener('change', (event) => {
      window.currentDepth = 0;
      window._lastEquityCalculationDepth = 0;
      updateTreeViewWithSelections(solutionTree);  // Uses current selections
      renderEqBuckets();
      renderEqDistribution();
      applyToChart(window.currentSNode, window.currentActions);
      // showLoadingOverlay();
      // window.electronAPI.runEquity('', '');  // Recalculates flop equity
    });
  }
  if (!riverContainer) {
    riverContainer = document.createElement('div');
    riverContainer.id = 'river-dropdown-container';
    const riverLabel = document.createElement('label');
    riverLabel.innerText = 'River Card: ';
    riverContainer.style.display =
        'inline-block';  // Ensure it's visible by default
    riverContainer.style.marginRight = '20px';
    riverContainer.appendChild(riverLabel);
    riverContainer.appendChild(riverSelect);
    const leftCol = document.getElementById('yui-main');
    leftCol.insertBefore(riverContainer, leftCol.children[1] || null);
  }

  function populateRiverDropdown() {
    const currentBoard = getCurrentBoardCards();
    const cardsToRemove = currentBoard;

    const availableRiverCards =
        sortCards(FULL_DECK.filter(c => !cardsToRemove.includes(c)));

    const currentRiverValue = riverSelect.value;
    riverSelect.innerHTML = '';
    riverSelect.appendChild(new Option('-- Select --', ''));
    availableRiverCards.forEach(c => {
      const option = document.createElement('option');
      option.value = c;
      option.innerText = c[0] + suitSymbol[c[1]];
      riverSelect.appendChild(option);
    });

    if (availableRiverCards.includes(currentRiverValue)) {
      riverSelect.value = currentRiverValue;
    } else {
      riverSelect.value = '';
    }
  }

  const availableTurnCards =
      sortCards(FULL_DECK.filter(c => !flopBoard.includes(c)));

  turnSelect.innerHTML = '';
  turnSelect.appendChild(new Option('-- Select --', ''));
  availableTurnCards.forEach(c => {
    const option = document.createElement('option');
    option.value = c;                            // Value is "Ac" format
    option.innerText = c[0] + suitSymbol[c[1]];  // Text is "A♣" format
    turnSelect.appendChild(option);
  });
  turnSelect.value = '';

  populateRiverDropdown();

  riverContainer.style.display = 'inline-block';
}

/**
 * Retrieves the current dropdown selections and re-renders the JSON tree view
 * using a filtered version of the solution tree.
 *
 * @param {object} solutionTree - The original solution tree.
 */
function updateTreeViewWithSelections(solutionTree) {
  const turnSelect = document.getElementById('turn-dropdown');
  const riverSelect = document.getElementById('river-dropdown');
  const turnSelection = turnSelect ? turnSelect.value : '';
  const riverSelection = riverSelect ? riverSelect.value : '';
  const filteredTree = solutionTree;
  //     filterSolutionTree(solutionTree, turnSelection, riverSelection);

  const jsonViewer = document.getElementById('json-viewer');
  jsonViewer.innerHTML = '';
  window._chanceNodeRenderCount = 0;
  createTreeView(filteredTree, jsonViewer, {chanceCounter: 0});
}

// --- Poker Hands Chart & s Coloring Section ---

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUITS = ['c', 'd', 'h', 's'];  // For generating hand combinations.
const pokerMatrix = [];              // holds the canonical label for each cell.
const pokerCells = [];               // holds references to <td> elements.

/**
 * Initializes the poker grid and attaches hover event listeners.
 */
function initPokerGrid(container) {
  const table = document.createElement('table');
  table.style.borderCollapse = 'collapse';
  table.style.width = '500px';
  table.style.height = '500px';
  table.style.margin = '20px auto';

  const n = RANKS.length;
  for (let i = 0; i < n; i++) {
    pokerMatrix[i] = [];
    pokerCells[i] = [];
    const tr = document.createElement('tr');
    for (let j = 0; j < n; j++) {
      const td = document.createElement('td');
      td.style.textAlign = 'center';
      td.style.verticalAlign = 'middle';
      td.style.backgroundColor = 'rgba(221, 221, 221, 0.8)';
      td.style.fontFamily = 'monospace';
      td.style.border = '1px dashed rgba(0, 0, 0, 0.2)';
      td.style.boxSizing = 'border-box';

      // Set canonical hand label in cell.
      if (i === j) {
        pokerMatrix[i][j] = RANKS[i] + RANKS[i];
      } else if (i < j) {
        pokerMatrix[i][j] = RANKS[i] + RANKS[j] + 's';
      } else {
        pokerMatrix[i][j] = RANKS[j] + RANKS[i] + 'o';
      }
      td.textContent = pokerMatrix[i][j];
      // Save the label as a data attribute.
      td.dataset.handLabel = pokerMatrix[i][j];

      // --- Hover Event Listeners to display EV details ---
      td.addEventListener('mouseenter', handleCellMouseEnter);
      td.addEventListener('mouseleave', handleCellMouseLeave);
      // --------------------------------------------------------

      tr.appendChild(td);
      pokerCells[i][j] = td;
    }
    table.appendChild(tr);
  }
  container.innerHTML = '';
  container.appendChild(table);
}

function handleCellMouseEnter(event) {
  const handLabel = event.currentTarget.dataset.handLabel;
  if (!window.currentSNode || !window.currentActions ||
      window.currentPlayer == null)
    return;

  const board = boardCardsForCurrentDepth();

  // reset panel
  let pane = document.getElementById('ev-display');
  if (!pane) {
    pane = document.createElement('div');
    pane.id = 'ev-display';
    document.getElementById('secondary').appendChild(pane);
  }
  pane.style.display = 'block';
  pane.innerHTML = '';

  const h = document.createElement('h4');
  h.textContent = `${handLabel} - Strategy & EV/EQ`;
  pane.appendChild(h);

  const grid = document.createElement('div');
  grid.className = 'ev-grid';
  pane.appendChild(grid);

  // choose the right equity map
  const phase = getEquityPhase();
  const eqData = window.equityMap[phase] || {};
  const eqMap = window.currentPlayer === 0 ? eqData.hero : eqData.villain;


  const combos = Object.keys(getCombinationEVs(window.currentSNode, handLabel));
  combos.forEach(cmb => {
    if (comboHasBoardCard(cmb, board)) return;
    const vecObj = window.currentSNode[cmb];
    if (!vecObj) return;

    // EV
    const vecArr = Object.keys(vecObj)
                       .sort((a, b) => Number(a) - Number(b))
                       .map(k => vecObj[k]);
    const ev = vecArr.at(-1);

    // EQ, try both orientations
    const flipped = cmb.slice(2, 4) + cmb.slice(0, 2);
    const equityRaw = eqMap ? (eqMap[cmb] ?? eqMap[flipped]) : undefined;
    const equityText = (equityRaw != null) ? `${equityRaw.toFixed(0)}%` : '-';

    // frequencies & tile
    const freqs = vecArr.slice(0, window.currentActions.length);
    const tile = document.createElement('div');
    tile.className = 'ev-card';
    tile.style.background = buildMixedColor(freqs, window.currentActions);
    tile.innerHTML = `<span class="hand">${formatCombo(cmb)}</span>` +
        `<span class="ev">EV ${ev.toFixed(2)}</span>` +
        `<span class="eq">EQ ${equityText}</span>`;
    grid.appendChild(tile);
  });

  if (!grid.childElementCount) {
    const note = document.createElement('div');
    note.style.opacity = 0.7;
    note.textContent = 'Not in range';
    grid.appendChild(note);
  }
}


function handleCellMouseLeave(event) {
  const table = document.querySelector('#secondary table');
  if (table && event.relatedTarget && table.contains(event.relatedTarget))
    return;
  showAggregateStrategy();
}

function computeAverageFrequencies(sNode, numActions) {
  const board = boardCardsForCurrentDepth();

  const sums = new Array(numActions).fill(0);
  let kept = 0;

  for (const cmb in sNode) {
    if (!Object.prototype.hasOwnProperty.call(sNode, cmb)) continue;
    if (comboHasBoardCard(cmb, board)) continue;  // ignore overlaps
    const vecObj = sNode[cmb];
    const vecArr = Object.keys(vecObj)
                       .sort((a, b) => Number(a) - Number(b))
                       .map(k => vecObj[k]);
    for (let i = 0; i < numActions; i++) sums[i] += vecArr[i];
    kept++;
  }
  return kept ? sums.map(s => s / kept) : sums;
}

/**
 * Helper function that, given the current sNode and a canonical hand label,
 * enumerates all possible 4-card combinations for that canonical hand and
 * returns an object mapping each combo to its EV (extracted as the last element
 * in its vector). For any combo not present in the player's range (i.e. not in
 * sNode), its EV is null.
 */
function getCombinationEVs(sNode, canonicalLabel) {
  const comboEVs = {};
  let combos = [];
  if (canonicalLabel.length === 2) {
    // generate all 12 ordered permutations so orientation always matches a
    // msgpack key
    const r = canonicalLabel[0];
    for (let i = 0; i < SUITS.length; i++) {
      for (let j = 0; j < SUITS.length; j++) {
        if (i === j) continue;
        combos.push(r + SUITS[i] + r + SUITS[j]);  // e.g. QhQd and QdQh
      }
    }
  } else if (canonicalLabel.length === 3) {
    // Non-pairs: either suited ("AKs") or offsuit ("AKo").
    const rank1 = canonicalLabel[0];
    const rank2 = canonicalLabel[1];
    const suffix = canonicalLabel[2];
    if (suffix === 's') {
      // Suited: both cards share the same suit.
      for (let s = 0; s < SUITS.length; s++) {
        const combo = rank1 + SUITS[s] + rank2 + SUITS[s];
        combos.push(combo);
      }
    } else if (suffix === 'o') {
      // Offsuit: cards have different suits.
      for (let i = 0; i < SUITS.length; i++) {
        for (let j = 0; j < SUITS.length; j++) {
          if (i === j) continue;
          const combo = rank1 + SUITS[i] + rank2 + SUITS[j];
          combos.push(combo);
        }
      }
    }
  }
  // For each potential combination, look it up in sNode.
  combos.forEach(cmb => {
    if (!sNode.hasOwnProperty(cmb)) {
      comboEVs[cmb] = null;
      return;
    }
    const vecObj = sNode[cmb];  // {"0":freq0,"1":freq1,...,"N":EV}
    const vecArr = Object.keys(vecObj)
                       .sort((a, b) => Number(a) - Number(b))
                       .map(k => vecObj[k]);
    comboEVs[cmb] = vecArr[vecArr.length - 1];  // EV = last element
  });

  return comboEVs;
}

function getCurrentBoardCards() {
  const suitMapReverse = {'♣': 'c', '♦': 'd', '♥': 'h', '♠': 's'};
  const cards = [];

  const flopInput = document.getElementById('flop-board');
  const flopTxt = (flopInput?.value || '').trim();
  if (flopTxt) {
    flopTxt.split(',').forEach(raw => {
      const t = raw.trim();
      if (t.length >= 2) {
        const rank = t.slice(0, -1).toUpperCase();
        const suitSymbol = t.slice(-1);                 // ♣, ♦, ♥, ♠
        const suitLetter = suitMapReverse[suitSymbol];  // c, d, h, s
        if (RANKS_SHORT.includes(rank) && SUITS_SHORT.includes(suitLetter)) {
          cards.push(rank + suitLetter);
        } else {
          console.warn(`Malformed card string in flop input: "${t}" -> Rank ${
              rank}, Suit Symbol ${suitSymbol}`);
        }
      }
    });
  }

  const tSel = document.getElementById('turn-dropdown');
  const tSelValue = tSel ? tSel.value : null;
  if (tSelValue && !cards.includes(tSelValue)) {
    cards.push(tSelValue);
  }

  const rSel = document.getElementById('river-dropdown');
  const rSelValue = rSel ? rSel.value : null;
  if (rSelValue && !cards.includes(rSelValue)) {
    cards.push(rSelValue);
  }

  // Returns array like ["Ac", "Kc", "Qc", "7d", "2h"]
  return cards.slice(0, 5);
}

function comboHasBoardCard(combo, board) {
  const c1 = combo.slice(0, 2);  // e.g. "Ah"
  const c2 = combo.slice(2, 4);  // e.g. "Kd"
  return board.includes(c1) || board.includes(c2);
}

function boardCardsForCurrentDepth() {
  /* 0 = flop, 1 = turn, 2 = river (saved by applyToChart) */
  const depth = window.currentDepth ?? 0;

  /* all cards that might be filled in the UI (flop text -> turn -> river) */
  const all = getCurrentBoardCards();  // e.g. ["Ah","Kd","Qs","7c","2d"]

  /* keep only what the player has actually seen at this tree node        */
  /* flop(3) + depth(0/1/2) = 3,4,5                                       */
  const keep = 3 + depth;
  return all.slice(0, keep);
}


// Initialize the flop selection UI after the DOM content is loaded.
document.addEventListener('DOMContentLoaded', async () => {
  const netid = await window.electronAPI.getNetID();
  const netidValueSpan = document.getElementById('netid-value');
  if (netidValueSpan) {
    netidValueSpan.textContent = netid;
  }
  const pokerChartContainer = document.getElementById('secondary');
  initPokerGrid(pokerChartContainer);
  initializeFlopSelection();

  /* ─── Sample-solutions UI setup ─────────────────────────────── */
  const browseBtn = document.getElementById('browseSampleBtn');
  const dropdown = document.getElementById('sampleDropdown');
  const saveBtn =
      document.getElementById('saveSolutionBtn');  // Get save button

  // Initially hide the save button
  if (saveBtn) {
    saveBtn.style.display = 'none';
  }

  async function loadMenu() {
    // Clear existing buttons first
    dropdown.innerHTML = '';
    const res = await window.electronAPI.listSampleSolutions();
    if (!res.success) {
      console.error(res.error);
      return;
    }
    const {data: nums, index: indexMap} = res;


    nums.forEach(n => {
      const title = indexMap[n] || `Solution ${n}`;
      const btn = document.createElement('button');
      btn.textContent = title;
      btn.addEventListener('click', async () => {
        dropdown.style.display = 'none';
        showLoadingOverlay();

        // Hide save button while loading a new one
        if (saveBtn) {
          saveBtn.style.display = 'none';
        }
        window._isSolutionLoaded = false;

        // 1) Fetch flop info for UI update *before* loading tree
        try {
          const flopRes = await window.electronAPI.getSampleFlop(n);
          if (flopRes.success && flopRes.board) {
            const inp = document.getElementById('flop-board');
            if (inp) {
              // Update the input field value visually using display format
              // (e.g., A♣)
              inp.value = flopRes.board.join(', ');

              // Also update the visual selection in the grid
              document.querySelectorAll('.card.selected')
                  .forEach(el => el.classList.remove('selected'));
              flopRes.board.forEach(
                  cardDisplay => {  // flopRes.board is already in display
                                    // format
                    const el = document.querySelector(
                        `.card[data-card="${cardDisplay}"]`);
                    if (el) el.classList.add('selected');
                  });
            }
          } else {
            console.error(
                'Failed to get sample flop for UI update:', flopRes.error);
            // Clear flop input if fetch failed? Or leave as is? Let's clear.
            const inp = document.getElementById('flop-board');
            if (inp) inp.value = '';
            document.querySelectorAll('.card.selected')
                .forEach(el => el.classList.remove('selected'));
          }
        } catch (flopError) {
          console.error('Error fetching sample flop for UI:', flopError);
          const inp = document.getElementById('flop-board');
          if (inp) inp.value = '';
          document.querySelectorAll('.card.selected')
              .forEach(el => el.classList.remove('selected'));
        }

        // 2) Load the solution data (tree + flop) via IPC
        // This call now implicitly triggers onRootTree which handles UI updates
        try {
          const out = await window.electronAPI.loadSampleSolution(n);
          // Note: hideLoadingOverlay is called within onRootTree's equity
          // callback
          if (!out.success) {
            hideLoadingOverlay();  // Hide if load itself failed
            alert(out.error || 'Failed to load sample solution.');
            return;
          }
          // If successful, onRootTree takes over UI updates.
        } catch (loadError) {
          hideLoadingOverlay();  // Hide on error
          console.error('Error calling loadSampleSolution:', loadError);
          alert(`Error loading solution: ${loadError.message}`);
        }
      });

      dropdown.appendChild(btn);
    });
  }
  await loadMenu();  // Initial load

  /* toggle dropdown visibility */
  browseBtn.addEventListener('click', () => {
    dropdown.style.display =
        dropdown.style.display === 'block' ? 'none' : 'block';
  });
  /* click-outside to close */
  document.addEventListener('click', e => {
    if (!browseBtn.contains(e.target) && !dropdown.contains(e.target))
      dropdown.style.display = 'none';
  });

  /* Save Button Listener */
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (!window._isSolutionLoaded) {
        alert('No solution is currently loaded to save.');
        return;
      }
      showLoadingOverlay();  // Indicate activity
      try {
        const result = await window.electronAPI.saveSampleSolution();
        hideLoadingOverlay();
        if (result.success) {
          alert(result.message || 'Solution saved successfully!');
          // Optionally reload the dropdown menu here after save
          await loadMenu();
        } else {
          alert(`Failed to save solution: ${result.error}`);
        }
      } catch (err) {
        hideLoadingOverlay();
        alert(`An error occurred during save: ${err.message}`);
        console.error('Save error:', err);
      }
    });
  }

  /* Listener for updates from main process after saving */
  window.electronAPI.onSampleSavedUpdateList(async () => {
    await loadMenu();  // Reload the dropdown
  });

  /* Listener for error messages from main process */
  window.electronAPI.onError((_event, message) => {
    alert(`Error: ${message}`);
    hideLoadingOverlay();  // Ensure overlay is hidden on error
  });
});

// --- "Run Solver" button event listener ---
document.getElementById('runSolverBtn').addEventListener('click', async () => {
  // show loading immediately
  showLoadingOverlay();

  // Clear previous progress logs and JSON view.
  document.getElementById('footer').innerHTML = '';
  const jsonViewer = document.getElementById('json-viewer');
  jsonViewer.innerHTML = '';
  // Hide save button while running solver
  const saveBtn = document.getElementById('saveSolutionBtn');
  if (saveBtn) {
    saveBtn.style.display = 'none';
  }
  window._isSolutionLoaded = false;
  window.equityMap = {};  // Clear old equity data

  // Retrieve the stored NetID.
  const netid = await window.electronAPI.getNetID();
  if (!netid) {
    hideLoadingOverlay();
    jsonViewer.innerText = 'No valid NetID found. Please log in again.';
    // Keep save button hidden
    return;
  }

  try {
    const response = await window.electronAPI.runSolver(netid);
    if (!response.success) {
      hideLoadingOverlay();
      jsonViewer.innerText = `Error: ${response.error}`;
      return;
    }

  } catch (err) {
    hideLoadingOverlay();
    jsonViewer.innerText = `Unexpected error: ${err.message}`;
  }
});


// --- Flop Board Selection UI Initialization ---
function initializeFlopSelection() {
  const cardGrid = document.getElementById('card-grid');
  const flopBoard = document.getElementById('flop-board');
  let selectedFlop = [];

  // Clear any existing cards in the grid
  cardGrid.innerHTML = '';

  // Define the suits and ranks (each suit will form one row)
  const SUITS = ['♣', '♦', '♥', '♠'];
  const RANKS =
      ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

  // Create card elements grouped by suit
  SUITS.forEach(suit => {
    RANKS.forEach(rank => {
      const cardElem = document.createElement('div');
      cardElem.classList.add('card');
      cardElem.textContent = rank + suit;
      cardElem.dataset.card = rank + suit;
      cardElem.addEventListener('click', () => {
        // Toggle selection: if this card is already selected, remove it.
        if (selectedFlop.includes(cardElem.dataset.card)) {
          selectedFlop = selectedFlop.filter(c => c !== cardElem.dataset.card);
          cardElem.classList.remove('selected');
        } else {
          // Limit selection to 3 cards (the flop)
          if (selectedFlop.length < 3) {
            selectedFlop.push(cardElem.dataset.card);
            cardElem.classList.add('selected');
          } else {
            // Optionally, show a message here that only 3 cards can be
            // selected.
            return;
          }
        }
        // Update the readonly textbox with the selected cards (comma separated)
        flopBoard.value = selectedFlop.join(', ');
      });
      cardGrid.appendChild(cardElem);
    });
  });
}

// --- Apply Flop Button Listener ---
document.getElementById('apply-flop-btn')
    .addEventListener('click', async () => {
      const flopBoard = document.getElementById('flop-board').value.trim();
      if (!flopBoard) {
        alert('No cards selected. Please select exactly 3 cards.');
        return;
      }
      const cards = flopBoard.split(',').map(c => c.trim()).filter(Boolean);
      if (cards.length !== 3) {
        alert('Please select exactly 3 cards for the flop.');
        return;
      }
      // Call the IPC method to update the input file.
      const response = await window.electronAPI.applyFlopBoard(flopBoard);
      if (response.success) {
        alert(response.message);
      } else {
        alert('Error applying flop board: ' + response.error);
      }
    });

// --- Dropdown Toggle for Flop Board ---
document.getElementById('flop-board').addEventListener('click', () => {
  const dropdown = document.getElementById('card-grid-dropdown');
  // Toggle the dropdown visibility
  if (dropdown.style.display === 'none' || dropdown.style.display === '') {
    dropdown.style.display = 'block';
  } else {
    dropdown.style.display = 'none';
  }
});

/**
 * Converts a specific combination string (e.g., "2d2c" or "AsKh")
 * into a canonical hand label (e.g., "22" for pocket pairs or "AKs"/"AKo" for
 * non-pairs).
 */
function canonicalHandLabel(fourCards) {
  if (!fourCards || fourCards.length < 4) return null;
  const rank1 = fourCards[0];
  const suit1 = fourCards[1];
  const rank2 = fourCards[2];
  const suit2 = fourCards[3];

  if (rank1 === rank2) {
    return rank1 + rank2;
  }
  const idx1 = RANKS.indexOf(rank1.toUpperCase());
  const idx2 = RANKS.indexOf(rank2.toUpperCase());
  if (idx1 < 0 || idx2 < 0) return null;

  const highRank = (idx1 < idx2) ? rank1.toUpperCase() : rank2.toUpperCase();
  const lowRank = (highRank === rank1.toUpperCase()) ? rank2.toUpperCase() :
                                                       rank1.toUpperCase();
  const suited = (suit1 === suit2);
  return suited ? (highRank + lowRank + 's') : (highRank + lowRank + 'o');
}

/**
 * Parses the s node where each key is a specific 4-card combo (e.g.,
 * "2d2c") and maps it to a canonical hand label. Returns an object mapping
 * canonical hand (e.g., "22", "AKs", "AKo") to an array of frequencies.
 */
function parseCanonicals(sNode) {
  const aggregated = {};
  const count = {};

  for (let combo in sNode) {
    if (!sNode.hasOwnProperty(combo)) continue;
    const freqObj = sNode[combo];
    const canLabel = canonicalHandLabel(combo);
    if (!canLabel) continue;
    const freqArr = Object.keys(freqObj).map(k => freqObj[k]);

    if (!aggregated[canLabel]) {
      aggregated[canLabel] = freqArr.slice();
      count[canLabel] = 1;
    } else {
      for (let i = 0; i < freqArr.length; i++) {
        aggregated[canLabel][i] += freqArr[i];
      }
      count[canLabel]++;
    }
  }
  for (let hand in aggregated) {
    const c = count[hand];
    for (let i = 0; i < aggregated[hand].length; i++) {
      aggregated[hand][i] /= c;
    }
  }
  return aggregated;
}

/**
 * Returns an appropriate color for a given a label.
 */
function getColorForAction(aLabel, index) {
  const label = aLabel.toUpperCase();
  if (label.startsWith('FOLD')) {
    return '#3399FF';
  } else if (label.startsWith('CALL') || label === 'CHECK') {
    return '#50FF50';
  } else if (label.startsWith('BET') || label.startsWith('RAISE')) {
    if (index === 1) return '#FF9999';
    if (index === 2) return '#FF5555';
    if (index === 3) return '#FF0000';
    return '#FFCCCC';
  }
  return '#DDDDDD';
}

/**
 * Given an array of frequency values and an array of a labels,
 * builds a CSS linear gradient that represents each a's frequency.
 */
function buildMixedColor(freqs, a) {
  let stops = [];
  let cumulative = 0;
  const numActions =
      a.length;  // number of available actions; EV (last element) is ignored
  for (let i = 0; i < numActions; i++) {
    const portion = freqs[i] * 100;
    if (portion <= 0) continue;
    const color = getColorForAction(a[i], i + 1);
    stops.push(`${color} ${cumulative}%`);
    stops.push(`${color} ${cumulative + portion}%`);
    cumulative += portion;
  }
  if (stops.length === 0) return '#DDD';
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/**
 * Applies the optimal strategy to color the poker chart.
 * Also stores the current strategy node globally for use in hover events.
 */
function applyToChart(sNode, a) {
  // get the board cards are known at this node (flop/turn/river)
  const board = boardCardsForCurrentDepth();

  // filter out any combos that intersect the board
  const filteredNode = {};
  for (const combo in sNode) {
    if (!comboHasBoardCard(combo, board)) {
      filteredNode[combo] = sNode[combo];
    }
  }

  // aggregate frequencies by canonical hand, only from non-overlapping combos
  const aggregated = parseCanonicals(filteredNode);
  console.log(
      '[applyToChart] Aggregated canonicals:', aggregated);  // Log the result

  // store for hover-EV/EQ lookup
  window.currentSNode = filteredNode;
  window.currentActions = a;

  // color the 13x13 grid
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      const label = pokerMatrix[i][j];
      const freqs = aggregated[label];
      pokerCells[i][j].style.background =
          freqs ? buildMixedColor(freqs, a) : '#ddd';
    }
  }

  // refresh the aggregate panel at the bottom
  showAggregateStrategy();
}



function showAggregateStrategy() {
  if (!window.currentSNode || !window.currentActions) return;

  const freqs = computeAverageFrequencies(
      window.currentSNode, window.currentActions.length);

  let pane = document.getElementById('ev-display');
  if (!pane) {
    pane = document.createElement('div');
    pane.id = 'ev-display';
    document.getElementById('secondary').appendChild(pane);
  }
  pane.style.display = 'block';
  pane.innerHTML = '';

  const h = document.createElement('h4');
  h.textContent = 'Strategy';
  pane.appendChild(h);

  const grid = document.createElement('div');
  grid.className = 'ev-grid';
  pane.appendChild(grid);

  window.currentActions.forEach((act, idx) => {
    const tile = document.createElement('div');
    tile.className = 'ev-card';
    tile.style.background = getColorForAction(act, idx + 1);
    tile.innerHTML = `<span class="hand">${act}</span><span class="ev">${
        (freqs[idx] * 100).toFixed(0)}%</span>`;
    grid.appendChild(tile);
  });
}

document.getElementById('customize-config')
    .addEventListener('click', async () => {
      await window.electronAPI.openConfigWindow();
    });