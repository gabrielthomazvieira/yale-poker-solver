let currentRangeType = null;  // 'ip' or 'oop'
let initialRangeString = '';

document.addEventListener('DOMContentLoaded', () => {
  const gridContainer = document.getElementById('range-grid');
  const frequencyPopup = document.getElementById('frequency-popup');
  const frequencyInput = document.getElementById('frequency-input');
  const frequencyApplyBtn = document.getElementById('frequency-apply');
  const frequencyCancelBtn = document.getElementById('frequency-cancel');
  const applyRangeBtn = document.getElementById('apply-range');
  const closeEditorBtn = document.getElementById('close-editor');

  const RANKS_SHORT =
      ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
  let rangeData = {};  // Stores hand -> frequency (0 to 1)
  let currentEditingCell = null;
  let isShiftDown = false;
  let firstShiftClickCell = null;

  // --- Initialization ---
  function initializeGrid() {
    gridContainer.innerHTML = '';
    for (let i = 0; i < 13; i++) {
      for (let j = 0; j < 13; j++) {
        const cell = document.createElement('div');
        cell.classList.add('grid-cell');
        const rank1 = RANKS_SHORT[i];
        const rank2 = RANKS_SHORT[j];
        let hand, handCanonical;
        let handText = '';

        if (i < j) {  // Suited hands (top-right triangle)
          hand = rank1 + rank2 + 's';
          handCanonical = rank1 + rank2 + 's';
          handText = rank1 + rank2 + 's';
          cell.classList.add('suited');
        } else if (i > j) {  // Offsuit hands (bottom-left triangle)
          hand = rank2 + rank1 + 'o';
          handCanonical = rank2 + rank1 + 'o';
          handText = rank2 + rank1 + 'o';
          cell.classList.add('offsuit');
        } else {  // Pairs (diagonal)
          hand = rank1 + rank2;
          handCanonical = rank1 + rank2;
          handText = rank1 + rank2;
          cell.classList.add('pair');
        }

        cell.dataset.hand = handCanonical;
        cell.dataset.row = i;
        cell.dataset.col = j;

        const textSpan = document.createElement('span');
        textSpan.classList.add('hand-text');
        textSpan.textContent = handText;
        cell.appendChild(textSpan);

        const fillDiv = document.createElement('div');
        fillDiv.classList.add('frequency-fill');
        fillDiv.style.height = '0%';  // Start with 0 fill
        cell.appendChild(fillDiv);

        cell.addEventListener('click', handleCellClick);
        cell.addEventListener('contextmenu', handleCellRightClick);
        gridContainer.appendChild(cell);
      }
    }
    // parseRangeString(initialRangeString);
    // updateGridVisuals();
  }

  // Inside DOMContentLoaded listener
  window.electronAPI.onInitialRangeData((data) => {
    console.log('Received initial data:', data);  // Debug log
    currentRangeType = data.rangeType;
    initialRangeString = data.initialRangeString;
    // Re-initialize or update the grid with the received data
    parseRangeString(initialRangeString);
    updateGridVisuals();

    // Update window title if needed (optional)
    const titleSuffix =
        currentRangeType ? ` - ${currentRangeType.toUpperCase()}` : '';
    document.title = `Range Editor${titleSuffix}`;
  });

  // --- Range String Parsing & Generation ---
  function parseRangeString(rangeStr) {
    rangeData = {};
    if (!rangeStr) return;
    const pairs = rangeStr.split(',');
    pairs.forEach(pair => {
      const [hand, freqStr] = pair.split(':');
      if (hand && freqStr) {
        const frequency = parseFloat(freqStr);
        if (!isNaN(frequency) && frequency >= 0 && frequency <= 1) {
          // Normalize hand format (e.g., KAs -> AKs, TJo -> JTo)
          const canonicalHand = getCanonicalHand(hand.trim());
          if (canonicalHand) {
            rangeData[canonicalHand] = frequency;
          }
        }
      }
    });
  }

  function generateRangeString() {
    return Object.entries(rangeData)
        .filter(
            ([_, freq]) => freq > 0)  // Only include hands with frequency > 0
        .map(
            ([hand, freq]) => `${hand}:${freq.toFixed(3)}`)  // Format frequency
        .join(',');
  }

  function getCanonicalHand(hand) {
    if (hand.length === 3) {  // Suited or Offsuit
      const r1 = hand[0];
      const r2 = hand[1];
      const type = hand[2];  // s or o
      const idx1 = RANKS_SHORT.indexOf(r1);
      const idx2 = RANKS_SHORT.indexOf(r2);
      if (idx1 === -1 || idx2 === -1 || (type !== 's' && type !== 'o'))
        return null;
      // Ensure consistent order (higher rank first)
      return idx1 < idx2 ? `${r1}${r2}${type}` : `${r2}${r1}${type}`;
    } else if (hand.length === 2) {  // Pair
      const r1 = hand[0];
      const r2 = hand[1];
      if (r1 !== r2 || RANKS_SHORT.indexOf(r1) === -1) return null;
      return hand;
    }
    return null;
  }

  // --- Grid Visual Update ---
  function updateGridVisuals() {
    const cells = gridContainer.querySelectorAll('.grid-cell');
    cells.forEach(cell => {
      const hand = cell.dataset.hand;
      const frequency = rangeData[hand] || 0;
      const fillDiv = cell.querySelector('.frequency-fill');
      const textSpan = cell.querySelector('.hand-text');

      fillDiv.style.height = `${frequency * 100}%`;
      textSpan.textContent = hand;

      if (frequency > 0) {
        cell.classList.add('selected');
      } else {
        cell.classList.remove('selected');
      }
    });
  }

  // --- Event Handlers ---
  function handleCellClick(event) {
    const cell = event.currentTarget;
    const hand = cell.dataset.hand;

    if (isShiftDown) {
      if (!firstShiftClickCell) {
        firstShiftClickCell = cell;
        // Highlight the first cell immediately
        toggleHandSelection(hand);
      } else {
        selectRange(firstShiftClickCell, cell);
        firstShiftClickCell = null;  // Reset after range selection
      }
    } else {
      firstShiftClickCell = null;  // Reset if shift is not down
      toggleHandSelection(hand);
    }
    updateGridVisuals();
  }

  function toggleHandSelection(hand) {
    if (rangeData[hand] && rangeData[hand] > 0) {
      rangeData[hand] = 0;  // Set to 0 if exists
    } else {
      rangeData[hand] = 1.0;  // Set to 1.0 if not exists or is 0
    }
  }

  function handleCellRightClick(event) {
    event.preventDefault();
    currentEditingCell = event.currentTarget;
    const hand = currentEditingCell.dataset.hand;
    const currentFreq = rangeData[hand] || 0;
    frequencyInput.value = (currentFreq * 100).toFixed(1);

    // Position popup near the clicked cell
    const rect = currentEditingCell.getBoundingClientRect();
    frequencyPopup.style.left = `${event.clientX}px`;
    frequencyPopup.style.top = `${event.clientY}px`;  // Adjust as needed
    frequencyPopup.style.display = 'block';
    frequencyInput.focus();
    frequencyInput.select();
  }

  frequencyApplyBtn.addEventListener('click', () => {
    if (currentEditingCell) {
      const hand = currentEditingCell.dataset.hand;
      let newFreqPercent = parseFloat(frequencyInput.value);
      if (isNaN(newFreqPercent) || newFreqPercent < 0) {
        newFreqPercent = 0;
      } else if (newFreqPercent > 100) {
        newFreqPercent = 100;
      }
      rangeData[hand] = newFreqPercent / 100.0;
      frequencyPopup.style.display = 'none';
      currentEditingCell = null;
      updateGridVisuals();
    }
  });

  frequencyCancelBtn.addEventListener('click', () => {
    frequencyPopup.style.display = 'none';
    currentEditingCell = null;
  });

  // Close popup if clicked outside
  document.addEventListener('click', (event) => {
    if (frequencyPopup.style.display === 'block' &&
        !frequencyPopup.contains(event.target) &&
        event.target !== currentEditingCell &&
        !currentEditingCell.contains(event.target)) {
      frequencyPopup.style.display = 'none';
      currentEditingCell = null;
    }
  });

  // --- Shift Key Handling for Multi-Select ---
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Shift') {
      isShiftDown = true;
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') {
      isShiftDown = false;
      firstShiftClickCell = null;  // Reset selection start on shift release
    }
  });

  function selectRange(startCell, endCell) {
    const startRow = parseInt(startCell.dataset.row);
    const startCol = parseInt(startCell.dataset.col);
    const endRow = parseInt(endCell.dataset.row);
    const endCol = parseInt(endCell.dataset.col);

    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);

    // Determine if the selection is adding (100%) or removing (0%)
    // Based on the state of the *end* cell clicked
    const endHand = endCell.dataset.hand;
    const targetFrequency =
        (rangeData[endHand] && rangeData[endHand] > 0) ? 0 : 1.0;

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const cell =
            gridContainer.querySelector(`[data-row="${r}"][data-col="${c}"]`);
        if (cell) {
          const hand = cell.dataset.hand;
          rangeData[hand] = targetFrequency;
        }
      }
    }
    updateGridVisuals();
  }

  // Replace the existing applyRangeBtn listener
  applyRangeBtn.addEventListener('click', async () => {  // Make async
    if (!currentRangeType) {
      console.error('Range type (IP/OOP) not set.');
      alert('Error: Range type not identified. Cannot apply.');
      return;
    }
    const newRangeString = generateRangeString();

    console.log(
        `Applying ${currentRangeType} range: ${newRangeString}`);  // Debug log

    try {
      const result = await window.electronAPI.applyRangeString(
          {rangeType: currentRangeType, rangeString: newRangeString});
      if (result.success) {
        console.log('Range applied successfully via main process.');
        window.close();  // Close the editor window on success
      } else {
        console.error('Failed to apply range:', result.error);
        alert(`Error applying range: ${result.error}`);
      }
    } catch (error) {
      console.error('IPC error applying range:', error);
      alert(`Error communicating with main process: ${error.message}`);
    }
  });

  closeEditorBtn.addEventListener('click', () => {
    window.close();  // Close the editor window
  });

  // --- Initial Load ---
  initializeGrid();
});
