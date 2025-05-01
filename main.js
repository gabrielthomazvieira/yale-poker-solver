const {app, BrowserWindow, ipcMain, dialog} = require('electron');
const path = require('node:path');
const {exec} = require('child_process');
const util = require('util');
const fs = require('fs');
const fse = require('fs-extra');
const msgpack = require('@msgpack/msgpack');
const fetch = (...args) =>
    import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();


// --- Reliable Paths ---

// 1. User Data Path
const USER_DATA_PATH = app.getPath('userData');

// 2. Resources Path
const RESOURCES_PATH = process.resourcesPath;

// --- Writable Operational Paths ---
const OPERATIONAL_INSTALL_DIR = path.join(USER_DATA_PATH, 'install');
const OPERATIONAL_EQUITY_DIR = path.join(USER_DATA_PATH, 'equity_calculator');
const INPUT_JSON_PATH =
    path.join(OPERATIONAL_INSTALL_DIR, 'resources', 'text', 'input.json');
const SAMPLE_DIR = path.join(USER_DATA_PATH, 'sample_solutions');
const OPERATIONAL_QUERY_SCRIPT =
    path.join(OPERATIONAL_INSTALL_DIR, 'query_solver_db.py');
const WORKING_MSGPACK_PATH = path.join(USER_DATA_PATH, 'output_result.msgpack');
const WORKING_MSGPACK_IDX_PATH =
    path.join(USER_DATA_PATH, 'output_result.msgpack.midx');
const LOCAL_EQUITY_DOWNLOAD_DIR =
    path.join(USER_DATA_PATH, 'equity_results_temp');

// --- Template/Source Paths (Read-Only, relative to RESOURCES_PATH) ---
const TEMPLATE_INSTALL_DIR = path.join(RESOURCES_PATH, 'install_template');
const TEMPLATE_EQUITY_DIR =
    path.join(RESOURCES_PATH, 'equity_calculator_template')

// --- Initialization Function ---
async function initializeAppData() {
  console.log('User Data Path:', USER_DATA_PATH);
  console.log('Resources Path:', RESOURCES_PATH);

  const itemsToInitialize = [
    {
      type: 'dir',
      source: TEMPLATE_INSTALL_DIR,
      destination: OPERATIONAL_INSTALL_DIR,
      name: 'Install Directory'
    },
    {
      type: 'dir',
      source: TEMPLATE_EQUITY_DIR,
      destination: OPERATIONAL_EQUITY_DIR,
      name: 'Equity Calculator'
    },
    {type: 'dir', destination: SAMPLE_DIR, name: 'Sample Solutions Directory'},
    {
      type: 'dir',
      destination: LOCAL_EQUITY_DOWNLOAD_DIR,
      name: 'Equity Download Directory'
    }
  ];

  for (const item of itemsToInitialize) {
    try {
      if (!fs.existsSync(item.destination)) {
        console.log(
            `${item.name} not found at ${item.destination}. Initializing...`);
        if (item.source) {
          // Source exists, copy directory recursively
          if (fs.existsSync(item.source)) {
            await fse.copy(item.source, item.destination);
            console.log(`Copied ${item.source} to ${item.destination}`);
          } else {
            console.error(`FATAL: Source template ${item.source} for ${
                item.name} not found. Check build configuration (extraResources?).`);
            dialog.showErrorBox(
                'Initialization Error',
                `Required template files (${
                    item.source}) are missing. The application might not work correctly.`);
            return;
          }
        } else {
          // No source, just create the destination directory
          fs.mkdirSync(item.destination, {recursive: true});
          console.log(`Created directory ${item.destination}`);
        }
      } else {
        console.log(`${item.name} found at ${item.destination}.`);
      }
    } catch (err) {
      console.error(
          `Error initializing ${item.name} at ${item.destination}:`, err);
      dialog.showErrorBox(
          'Initialization Error',
          `Failed to initialize ${item.name}: ${err.message}`);
      return;  // Stop initialization on error
    }
  }
  console.log('App data initialization complete.');
}


// Map Unicode suits to letters.
const suitMapping = {
  '♣': 'c',
  '♦': 'd',
  '♥': 'h',
  '♠': 's'
};

// Map letters to Unicode suits
const suitMappingUnicode = {
  c: '♣',
  d: '♦',
  h: '♥',
  s: '♠'
};

let rangeEditorWindow;

/* ─── Lazy MsgPack Reader ─────────────────────────────────────────── */
const LZ = (() => {
  const IDX_HDR = 14;  // sizeof(IdxEntryHdr) from C++ (8+4+2)
  /** in-memory index: path → {off,len} */
  let MAP = new Map();
  /** file descriptor for the .msgpack (kept open) */
  let FD = null;
  /** decoded root (shallow), produced once */
  let ROOT = null;

  function loadIndex(msgpackPath) {
    if (MAP.size) return;  // already loaded
    const idxPath = `${msgpackPath}.midx`;
    const buf = fs.readFileSync(idxPath);
    let p = 0;
    while (p < buf.length) {
      const off = buf.readBigUInt64LE(p);     // 0..7
      const len = buf.readUInt32LE(p + 8);    // 8..11
      const plen = buf.readUInt16LE(p + 12);  // 12..13
      const path = buf.slice(p + IDX_HDR, p + IDX_HDR + plen).toString();
      MAP.set(path, {off: Number(off), len});
      p += IDX_HDR + plen;
    }
  }

  /** minimum-work stream decode: fetch slice, decode. */
  function getSlice(path) {
    const meta = MAP.get(path);
    if (!meta) throw new Error(`Path not indexed: ${path}`);
    const {off, len} = meta;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(FD, buf, 0, len, off);
    return msgpack.decode(buf);
  }

  /** public API used by IPC */
  return {
    init(msgpackPath) {
      loadIndex(msgpackPath);
      FD = fs.openSync(msgpackPath, 'r');
      ROOT = getSlice('');  // root object (few KB)
      return ROOT;
    },
    subtree(path) {
      if (path === '') return ROOT;
      return getSlice(path);
    },
    close() {
      if (FD) fs.closeSync(FD);
      FD = null;
      MAP.clear();
      ROOT = null;
    }
  };
})();

// Promisify exec for easier async/await usage
const execPromise = util.promisify(exec);

/** SSH options */
const SSH_OPTIONS =
    '-o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10';

/* ─── Lazy SQL Reader (Remote via SSH) ─────────────────────────────────── */
const SQLZ = (() => {
  /** In-memory cache: path -> decoded node data */
  let CACHE = new Map();
  /** Remote database path */
  let REMOTE_DB_PATH = null;
  /** Remote user@host */
  let SSH_USER_HOST = null;
  /** Path to the remote python query script */
  const REMOTE_SCRIPT_PATH = '~/yale-poker/query_solver_db.py';

  /** Fetches nodes via SSH and decodes them */
  async function fetchNodesViaSSH(pathsToFetch) {
    const logPrefix = '[SQLZ fetchNodesViaSSH]';
    pathsToFetch = pathsToFetch.map(p => p?.trim())
                       .filter(p => p !== undefined && p !== null);
    if (pathsToFetch.length > 1) {
      pathsToFetch = pathsToFetch.filter(p => p !== '');
    }
    if (pathsToFetch.length === 0) {
      return new Map();
    }
    if (!REMOTE_DB_PATH || !SSH_USER_HOST) {
      console.error(`${logPrefix} Error: SQLZ not initialized.`);
      throw new Error(
          'SQLZ not initialized with remote DB path or SSH user/host.');
    }

    const displayPaths = pathsToFetch.length > 20 ?
        `${pathsToFetch.slice(0, 10).join(', ')} ... (${
            pathsToFetch.length} total)` :
        pathsToFetch.join(', ');
    console.log(`${logPrefix} Requesting fetch for ${
        pathsToFetch.length} path(s): [${displayPaths}]`);

    const pathsJsonString = JSON.stringify(pathsToFetch);
    const pathsJsonBase64 = Buffer.from(pathsJsonString).toString('base64');
    const remoteDbPathEscaped = `"${REMOTE_DB_PATH}"`;
    const remoteScriptPathEscaped = `"${REMOTE_SCRIPT_PATH}"`;
    const remoteCommand = `python3 ${remoteScriptPathEscaped} --db_path ${
        remoteDbPathEscaped} --batch_json_base64 '${pathsJsonBase64}'`;
    const sshCmd = `ssh ${SSH_OPTIONS} ${SSH_USER_HOST} "${remoteCommand}"`;

    const results = new Map();
    try {
      const {stdout, stderr} = await execPromise(
          sshCmd, {maxBuffer: 1024 * 1024 * 200, timeout: 120000});
      if (stderr) {
        console.warn(`${logPrefix} SSH command stderr: ${stderr}`);
      }

      let response;
      try {
        response = JSON.parse(stdout);
      } catch (jsonError) {
        console.error(`${logPrefix} Failed to parse JSON response. Length: ${
            stdout.length}. Error: ${jsonError.message}`);
        console.error(
            `${logPrefix} Raw stdout: ${stdout.substring(0, 1000)}...`);
        throw new Error(
            `SQLZ JSON Parsing Error: ${jsonError.message}. Stderr: ${stderr}`);
      }

      if (response.error) {
        console.error(`${logPrefix} Remote script error: ${response.error}`);
        throw new Error(`SQLZ Remote script error: ${response.error}`);
      }
      if (!response.results || typeof response.results !== 'object') {
        console.error(`${logPrefix} Invalid response format:`, response);
        throw new Error(
            'SQLZ Invalid response format: missing/invalid "results" key.');
      }

      const receivedCount = Object.keys(response.results).length;

      for (const [path, base64Data] of Object.entries(response.results)) {
        if (base64Data && typeof base64Data === 'string') {
          try {
            const rawBlob = Buffer.from(base64Data, 'base64');
            const decodedNode = msgpack.decode(rawBlob);
            results.set(path, decodedNode);
          } catch (processingError) {
            console.error(`${logPrefix} Error processing data for path "${
                path}": ${processingError.message}`);
            results.set(path, null);
          }
        } else {
          results.set(path, null);
        }
      }
    } catch (error) {
      console.error(`${logPrefix} SSH command execution or processing failed: ${
          error.stack || error}`);
      pathsToFetch.forEach(path => {
        if (!results.has(path)) {
          results.set(path, null);
        }
      });
      throw error;
    }
    return results;
  }

  function updateCache(fetchedMap) {
    const logPrefix = '[SQLZ updateCache]';
    let updatedCount = 0;
    fetchedMap.forEach((value, key) => {
      const oldValue = CACHE.get(key);
      if (value !== null || !CACHE.has(key) || oldValue === null) {
        if (oldValue !== value) {
          updatedCount++;
        }
        CACHE.set(key, value);
      }
    });
    if (updatedCount > 0) {
      console.log(`${logPrefix} Updated/added ${
          updatedCount} node(s) to cache. Cache size: ${CACHE.size}`);
    }
  }

  /**
   * Fetches an action node and ALL its required dependencies for UI display
   * (children c.i, strategy s, s.a, s.s, s.s.HandKey) using multi-stage
   * fetching, then reconstructs the node object in the cache.
   * @param {string} basePath - The path of the action node to fetch/reconstruct
   *     (e.g., '', 'c.0').
   * @returns {Promise<object|null>} The fully reconstructed node object, or
   *     null on failure.
   */
  async function fetchAndReconstructActionNode(basePath) {
    const logPrefix = `[SQLZ fetchAndReconstruct path="${basePath || '\'\''}"]`;

    try {
      // --- Stage 1: Fetch Action Node itself (if needed) ---
      let actionNodeData = CACHE.get(basePath);
      if (!actionNodeData || actionNodeData === null) {
        const nodeMap = await fetchNodesViaSSH([basePath]);
        updateCache(nodeMap);
        actionNodeData = CACHE.get(basePath);
      }

      if (!actionNodeData || typeof actionNodeData !== 'object' ||
          actionNodeData.t !== 'a') {
        console.error(
            `${logPrefix} Node at path "${
                basePath}" is not a valid Action Node. Data:`,
            actionNodeData);
        CACHE.set(basePath, null);  // Mark as invalid in cache
        return null;                // Return null on failure
      }

      // --- Stage 2: Fetch 'c' and 's' containers ---
      const cPath = basePath === '' ? 'c' : `${basePath}.c`;
      const sPath = basePath === '' ? 's' : `${basePath}.s`;
      const stage2Paths = [];
      if (actionNodeData.hasOwnProperty('c') &&
          (!CACHE.has(cPath) || CACHE.get(cPath) === null))
        stage2Paths.push(cPath);
      if (actionNodeData.hasOwnProperty('s') &&
          (!CACHE.has(sPath) || CACHE.get(sPath) === null))
        stage2Paths.push(sPath);
      if (stage2Paths.length > 0) {
        const stage2Map = await fetchNodesViaSSH(stage2Paths);
        updateCache(stage2Map);
      }
      const sData = CACHE.get(sPath);  // Get potentially fetched 's' data

      // --- Stage 3: Fetch 's.a' and 's.s' structures if needed ---
      const saPath = `${sPath}.a`;
      const ssPath = `${sPath}.s`;
      let stage3Paths = [];
      if (sData && typeof sData === 'object') {
        if (sData.hasOwnProperty('a') && sData.a === null && !CACHE.has(saPath))
          stage3Paths.push(saPath);
        if (sData.hasOwnProperty('s') && sData.s === null && !CACHE.has(ssPath))
          stage3Paths.push(ssPath);
      } else if (sData === null && actionNodeData.s === null) {  // If 's'
                                                                 // itself was
                                                                 // pointer
        if (!CACHE.has(saPath)) stage3Paths.push(saPath);
        if (!CACHE.has(ssPath)) stage3Paths.push(ssPath);
      }

      if (stage3Paths.length > 0) {
        const stage3Map = await fetchNodesViaSSH(stage3Paths);
        updateCache(stage3Map);
      }
      const ssDataStructure =
          CACHE.get(ssPath);  // Structure like {'HandKey': null, ...}

      // --- Stage 4: Fetch all 'c.i' children and 's.s.HandKey' details ---
      let stage4Paths = [];
      // Children paths (c.0, c.1, ...)
      const numActions =
          Array.isArray(actionNodeData.a) ? actionNodeData.a.length : 0;
      if (numActions > 0 && actionNodeData.hasOwnProperty('c')) {
        for (let i = 0; i < numActions; i++) {
          const childPath = `${cPath}.${i}`;  // e.g., c.0 or P.c.0
          if (!CACHE.has(childPath)) stage4Paths.push(childPath);
        }
      }

      // Strategy hand detail paths (s.s.HandKey)
      let handKeys = [];
      if (ssDataStructure && typeof ssDataStructure === 'object') {
        handKeys = Object.keys(ssDataStructure);
        handKeys.forEach(handKey => {
          if (ssDataStructure[handKey] === null) {
            const handPath =
                `${ssPath}.${handKey}`;  // e.g., s.s.HandKey or P.s.s.HandKey
            if (!CACHE.has(handPath)) stage4Paths.push(handPath);
          } else {  // Cache inline data if present
            const handPath = `${ssPath}.${handKey}`;
            if (!CACHE.has(handPath))
              CACHE.set(handPath, ssDataStructure[handKey]);
          }
        });
      }

      if (stage4Paths.length > 0) {
        const stage4FetchMap = await fetchNodesViaSSH(stage4Paths);
        updateCache(stage4FetchMap);  // Cache all results
      }

      // --- Stage 5: Reconstruct Action Node Object for Return ---
      // Start with a deep copy of the base data fetched/found in Stage 1
      let reconstructedNode = JSON.parse(JSON.stringify(CACHE.get(basePath)));

      // Reconstruct 'c' array
      if (reconstructedNode.hasOwnProperty('c')) {
        const finalCArray = new Array(numActions).fill(null);
        for (let i = 0; i < numActions; i++) {
          const childPath = `${cPath}.${i}`;
          finalCArray[i] = CACHE.get(childPath) ?? null;  // Use fetched or null
        }
        reconstructedNode.c = finalCArray;
      }

      // Reconstruct 's' object
      if (reconstructedNode.hasOwnProperty('s')) {
        const sNodeFromCache = CACHE.get(sPath);
        if (sNodeFromCache && typeof sNodeFromCache === 'object') {
          reconstructedNode.s = JSON.parse(
              JSON.stringify(sNodeFromCache));  // Deep copy 's' structure

          // Populate .s.a
          reconstructedNode.s.a = CACHE.get(saPath) ?? reconstructedNode.s.a;

          // Populate .s.s
          const ssStructureFromCache = CACHE.get(ssPath);
          if (ssStructureFromCache &&
              typeof ssStructureFromCache === 'object') {
            const finalSSObject = {};
            Object.keys(ssStructureFromCache).forEach(handKey => {
              const handPath = `${ssPath}.${handKey}`;
              finalSSObject[handKey] = CACHE.get(handPath) ??
                  ssStructureFromCache[handKey];  // Use fetched detail or
                                                  // original
            });
            reconstructedNode.s.s = finalSSObject;
          } else {
            reconstructedNode.s.s =
                ssStructureFromCache;  // Assign null/invalid structure if
                                       // that's what was cached
          }
        } else {
          reconstructedNode.s =
              sNodeFromCache;  // Assign null if 's' was null/invalid
        }
      }

      // --- Update the cache with the reconstructed node ---
      CACHE.set(basePath, reconstructedNode);
      return reconstructedNode;  // Return the fully populated object

    } catch (error) {
      console.error(`${logPrefix} Failed: ${error.message}`, error);
      // Ensure cache reflects failure for the base path
      CACHE.set(basePath, null);
      throw new Error(`SQLZ: Failed to fetch/reconstruct action node "${
          basePath}": ${error.message}`);
    }
  }


  /** Public API */
  return {
    /**
     * Initialize SQLZ for a new solution. Performs the specific multi-stage
     * fetch and reconstruction for the root node.
     */
    async init(remoteDbPath, sshUserHost) {
      REMOTE_DB_PATH = remoteDbPath;
      SSH_USER_HOST = sshUserHost;
      CACHE.clear();
      console.log(`${logPrefix} Cache cleared.`);
      return fetchAndReconstructActionNode('');
    },

    /**
     * Get data for a specific path.
     * - If the path ends with '.<integer>.c' (In-Position Player node),
     * first ensure its parent action node (path up to '.<integer>')
     * is fully reconstructed, then fetch the requested node.
     * - If the path corresponds to any other action node, trigger the
     * full multi-stage fetch and reconstruction for it.
     * - Otherwise, perform a simple fetch.
     */
    async subtree(requestedPath) {
      if (requestedPath === '') {
        console.warn(`${
            logPrefix} subtree called for root path ''. Returning cached root (should be reconstructed by init).`);
        return CACHE.get('');
      }

      const playerNodeMatch = requestedPath.match(/^(.*)\.(\d+)\.c$/);
      if (playerNodeMatch &&
          currentDataSource === 'sqlz') {  // Aplica apenas para SQLZ
        const parentActionPath =
            `${playerNodeMatch[1]}.${playerNodeMatch[2]}`;  // Ex: 'c.1'
        const originalChildPath = requestedPath;            // Ex: 'c.1.c'

        try {
          let parentNode = CACHE.get(parentActionPath);
          let parentNeedsReconstruction = !parentNode ||
              (typeof parentNode === 'object' && parentNode.t === 'a' &&
               parentNode.c === null);

          if (parentNeedsReconstruction) {
            parentNode = await fetchAndReconstructActionNode(parentActionPath);
          }

          if (!parentNode) {
            console.error(`${logPrefix} Parent action node "${
                parentActionPath}" could not be loaded or reconstructed. Cannot proceed for child "${
                originalChildPath}".`);
            return null;
          }

        } catch (parentError) {
          console.error(
              `${logPrefix} Error reconstructing parent node "${
                  parentActionPath}": ${parentError.message}`,
              parentError);
          CACHE.set(parentActionPath, null);
          CACHE.set(originalChildPath, null);
          return null;
        }

        const reconstructedParentNode = CACHE.get(parentActionPath);
        if (reconstructedParentNode &&
            reconstructedParentNode.c !== undefined &&
            Array.isArray(reconstructedParentNode.c)) {
          return reconstructedParentNode.c;
        } else {
          console.error(
              `${logPrefix} Reconstructed parent node "${
                  parentActionPath}" is missing, or its '.c' property is missing/not an array after reconstruction! Parent Node:`,
              reconstructedParentNode);
          CACHE.set(originalChildPath, null);
          return null;
        }
      }

      let nodeData = CACHE.get(requestedPath);
      let needsReconstruction = nodeData && typeof nodeData === 'object' &&
          nodeData.t === 'a' && nodeData.c === null;

      if (nodeData !== undefined && nodeData !== null && !needsReconstruction) {
        console.log(`${logPrefix} Found valid, non-null${
            needsReconstruction ? ' (but needs reconstruction)' :
                                  ''} data in cache. Returning cached data.`);
        return nodeData;
      } else if (nodeData === null) {
        console.log(`${
            logPrefix} Found explicit null in cache. Will attempt fetch and potentially reconstruct.`);
      } else if (needsReconstruction) {
        console.log(`${
            logPrefix} Found action node in cache, but needs reconstruction (c is null).`);
      } else {
        console.log(`${logPrefix} Not found in cache. Fetching...`);
      }

      try {
        if (needsReconstruction) {
          console.log(`${
              logPrefix} Triggering reconstruction for cached action node...`);
          nodeData = await fetchAndReconstructActionNode(requestedPath);
        } else {
          const fetchedMap = await fetchNodesViaSSH([requestedPath]);
          updateCache(fetchedMap);
          nodeData = CACHE.get(requestedPath);

          if (nodeData === null || nodeData === undefined) {
            console.error(`${logPrefix} Fetch completed, but path "${
                requestedPath}" is still null/undefined in cache. Cannot proceed.`);
            return null;
          }

          if (nodeData && typeof nodeData === 'object' && nodeData.t === 'a') {
            console.log(`${
                logPrefix} Fetched node is an action node. Triggering full reconstruction...`);
            nodeData = await fetchAndReconstructActionNode(requestedPath);
          } else {
            console.log(`${
                logPrefix} Node is not an action node OR already reconstructed. Reconstruction not required.`);
          }
        }

        console.log(
            `${logPrefix} Operation complete. Returning data for path "${
                requestedPath}"`);
        return nodeData;

      } catch (error) {
        console.error(`${logPrefix} Failed for path "${requestedPath}": ${
            error.message}`);
        CACHE.set(requestedPath, null);
        return null;
      }
    },

    /** Clear cache and reset state */
    close() {
      console.log('[SQLZ close] Closing and clearing cache.');
      CACHE.clear();
      REMOTE_DB_PATH = null;
      SSH_USER_HOST = null;
    },

    /** Check if currently active */
    isActive() {
      const active = REMOTE_DB_PATH !== null && SSH_USER_HOST !== null;
      return active;
    }
  };
})();

// --- State Management for Data Source ---
let currentDataSource =
    'none';  // 'none', 'lz' (local msgpack), 'sqlz' (remote sql)

let loginWindow;
let solverWindow;

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 400,
    height: 300,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  loginWindow.loadFile('login.html');
}

function createSolverWindow() {
  solverWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  solverWindow.loadFile('index.html');
  // solverWindow.webContents.openDevTools();
}

app.whenReady().then(async () => {
  await initializeAppData();
  console.log('App is ready. Creating login window...');
  createLoginWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createLoginWindow();
    }
  });
});

// IPC handler for login to perform SSH check.
ipcMain.handle('login', async (event, netid) => {
  console.log('Received login request with netid:', netid);
  const remoteHost = 'node.zoo.cs.yale.edu';
  const sshCmd = `ssh -t -o BatchMode=yes ${netid}@${remoteHost} "exit"`;
  try {
    await new Promise((resolve, reject) => {
      exec(sshCmd, {timeout: 10000}, (error, stdout, stderr) => {
        if (error) {
          console.error('SSH login check failed:', error.message);
          return reject(new Error(`SSH login failed: ${error.message}`));
        }
        resolve();
      });
    });
    // Store the valid NetID in a global shared object.
    global.sharedObject = {netid: netid};
    return {success: true};
  } catch (err) {
    return {success: false, error: err.message};
  }
});

/* ─── Browse available sample solutions ───────────────────────── */
// ipcMain.handle('sample:list', async () => {
//   try {
//     const files = fs.readdirSync(SAMPLE_DIR);
//     const nums = new Set();
//     files.forEach(f => {
//       const m = f.match(/^output_result_(\d+)\.msgpack$/);
//       if (m &&
//           fs.existsSync(`${SAMPLE_DIR}/output_result_${m[1]}.msgpack.midx`) &&
//           fs.existsSync(`${SAMPLE_DIR}/input_${m[1]}.txt`))
//         nums.add(Number(m[1]));
//     });
//     const list = [...nums].sort((a, b) => a - b);

//     // load index.json
//     const indexPath = path.join(SAMPLE_DIR, 'index.json');
//     let indexMap = {};
//     if (fs.existsSync(indexPath)) {
//       indexMap = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
//     }

//     return {success: true, data: list, index: indexMap};
//   } catch (e) {
//     return {success: false, error: e.message};
//   }
// });

// ─── Get flop board for a given sample solution ───────────────
// ipcMain.handle('sample:flop', async (_evt, num) => {
//   try {
//     const inpPath =
//         path.join(SAMPLE_DIR, `input_${num}.json`);  // Look for JSON
//     if (!fs.existsSync(inpPath)) {
//       return {
//         success: false,
//         error: `Sample input JSON input_${num}.json not found.`
//       };
//     }
//     const content = fs.readFileSync(inpPath, 'utf8');
//     const config = JSON.parse(content);
//     const boardArray =
//         config?.gameSetup?.board;  // Expecting ["Ac", "Kd", "Qs"]

//     if (boardArray && Array.isArray(boardArray)) {
//       // Convert back to display format for UI (e.g., A♣)
//       const suitMap = {c: '♣', d: '♦', h: '♥', s: '♠'};
//       const cards = boardArray.map(c => {
//         const r = c.slice(0, -1);
//         const s = c.slice(-1);
//         return r + (suitMap[s] || s);
//       });
//       return {success: true, board: cards};  // Return cards in display format
//     }
//     return {success: false, error: 'No valid board found in sample JSON'};
//   } catch (e) {
//     console.error(
//         `Error reading sample input JSON for flop (input_${num}.json):`, e);
//     return {success: false, error: e.message};
//   }
// });

// ipcMain.handle('sample:load', async (event, num) => {
//   try {
//     const srcMsg = path.join(SAMPLE_DIR, `output_result_${num}.msgpack`);
//     const srcIdx = path.join(SAMPLE_DIR, `output_result_${num}.msgpack.midx`);
//     const srcInp = path.join(SAMPLE_DIR, `input_${num}.json`);
//     const dstMsg = path.join(__dirname, 'output_result.msgpack');
//     const dstIdx = path.join(__dirname, 'output_result.msgpack.midx');
//     const dstInp = INPUT_JSON_PATH;

//     // Check if source JSON exists
//     if (!fs.existsSync(srcInp)) {
//       return {
//         success: false,
//         error: `Sample input JSON (input_${num}.json) not found.`
//       };
//     }
//     if (!fs.existsSync(srcMsg) || !fs.existsSync(srcIdx)) {
//       return {
//         success: false,
//         error: `Sample result/index file for ${num} not found.`
//       };
//     }


//     // --- Ensure SQLZ is inactive ---
//     SQLZ.close();
//     currentDataSource = 'none';
//     // -------------------------------

//     // --- Fetch Flop Board Info from JSON ---
//     let flopBoard = [];  // Expecting format like ["Ac", "Kd", "Qs"]
//     let fetchError = null;
//     try {
//       const content = fs.readFileSync(srcInp, 'utf8');
//       const config = JSON.parse(content);
//       flopBoard = config?.gameSetup?.board || [];
//       if (!Array.isArray(flopBoard) || flopBoard.length !== 3) {
//         fetchError = 'Invalid or missing board array in sample JSON.';
//         flopBoard = [];  // Reset if invalid
//       }
//     } catch (e) {
//       fetchError = `Error reading sample input JSON: ${e.message}`;
//     }
//     // -----------------------------

//     if (fetchError &&
//         fetchError.startsWith('Error reading sample input JSON')) {
//       throw new Error(fetchError);  // Throw if JSON parsing failed
//     }

//     // Copy sample files locally
//     fs.copyFileSync(srcMsg, dstMsg);
//     fs.copyFileSync(srcIdx, dstIdx);
//     fs.copyFileSync(srcInp, dstInp);  // Copy JSON to working directory

//     // Initialize LZ module
//     LZ.close();
//     const rootObj = LZ.init(dstMsg);
//     currentDataSource = 'lz';

//     // Send root tree AND the fetched flop board
//     event.sender.send('root-tree', {root: rootObj, flop: flopBoard});

//     return {success: true, flop: flopBoard, flopError: fetchError};

//   } catch (e) {
//     console.error('Error in sample:load:', e);
//     LZ.close();
//     SQLZ.close();
//     currentDataSource = 'none';
//     return {success: false, error: e.message};
//   }
// });

// ipcMain.handle('sample:save', async (event) => {
//   try {
//     // 1. Determine the next available index
//     const indexPath = path.join(SAMPLE_DIR, 'index.json');
//     let indexMap = {};
//     let nextIndex = 1;
//     if (fs.existsSync(indexPath)) {
//       try {
//         indexMap = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
//         const existingIndices =
//             Object.keys(indexMap).map(Number).filter(n => !isNaN(n));
//         if (existingIndices.length > 0) {
//           nextIndex = Math.max(...existingIndices) + 1;
//         }
//       } catch (parseError) {
//         console.error(
//             'Error parsing index.json, starting index from 1:', parseError);
//         // Keep nextIndex as 1 if parsing fails
//       }
//     }

//     // Create the window to ask for the title directly
//     let titlePromptWindow = new BrowserWindow({
//       width: 400,
//       height: 230,
//       parent: BrowserWindow.getFocusedWindow(),
//       modal: true,
//       show: false,
//       webPreferences: {
//         preload: path.join(__dirname, 'preload.js'),
//         contextIsolation: true,
//         nodeIntegration: false,
//       }
//     });

//     // Prevent the window title from being changed by the HTML
//     titlePromptWindow.on('page-title-updated', (e) => e.preventDefault());
//     titlePromptWindow.loadFile('title_prompt.html');
//     // Set the window title here instead of in HTML
//     titlePromptWindow.once('ready-to-show', () => {
//       titlePromptWindow.setTitle('Save Solution');  // Set title here
//       titlePromptWindow.show();
//     });


//     // Wait for the title from the prompt window
//     const userTitle = await new Promise((resolve) => {
//       ipcMain.once('submit-title', (_event, title) => {
//         if (titlePromptWindow && !titlePromptWindow.isDestroyed()) {
//           titlePromptWindow.close();
//         }
//         titlePromptWindow = null;  // Clean up reference
//         resolve(title);
//       });
//       // Handle window closed before submitting (acts as cancel)
//       titlePromptWindow.on('closed', () => {
//         ipcMain.removeListener('submit-title', resolve);  // Clean up listener
//         resolve(null);  // Indicate cancellation or closure
//       });
//     });

//     if (userTitle === null) {  // Check specifically for null from closed window
//       console.log('Title input cancelled or empty.');
//       return {success: false, error: 'Save cancelled by user.'};
//     }

//     // 3. Prettify Title
//     const prettyTitle = userTitle.replace(
//         /([2-9ATJQK])([cdhs])/g,
//         (match, rank, suit) => rank + (suitMappingUnicode[suit] || suit));


//     // 4. Define source and destination paths
//     const srcMsg = path.join(__dirname, 'output_result.msgpack');
//     const srcIdx = path.join(__dirname, 'output_result.msgpack.midx');
//     const srcInp =
//         path.join(__dirname, 'install', 'resources', 'text', 'input.txt');

//     const dstMsg = path.join(SAMPLE_DIR, `output_result_${nextIndex}.msgpack`);
//     const dstIdx =
//         path.join(SAMPLE_DIR, `output_result_${nextIndex}.msgpack.midx`);
//     const dstInp = path.join(SAMPLE_DIR, `input_${nextIndex}.txt`);

//     // Ensure sample_solutions directory exists
//     if (!fs.existsSync(SAMPLE_DIR)) {
//       fs.mkdirSync(SAMPLE_DIR, {recursive: true});
//     }

//     // Check if source files exist before copying
//     if (!fs.existsSync(srcMsg) || !fs.existsSync(srcIdx) ||
//         !fs.existsSync(srcInp)) {
//       throw new Error(
//           'One or more source solution files not found. Cannot save.');
//     }

//     // 5. Copy files
//     fs.copyFileSync(srcMsg, dstMsg);
//     fs.copyFileSync(srcIdx, dstIdx);
//     fs.copyFileSync(srcInp, dstInp);

//     // 6. Update index.json
//     indexMap[nextIndex] = prettyTitle || `Solution ${nextIndex}`;
//     fs.writeFileSync(indexPath, JSON.stringify(indexMap, null, 2), 'utf8');

//     event.sender.send('sample-saved-update-list');

//     return {
//       success: true,
//       message: `Solution saved as "${
//           prettyTitle || `Solution ${nextIndex}`}" (Index ${nextIndex})`
//     };

//   } catch (e) {
//     console.error('Error saving sample solution:', e);
//     event.sender.send('error-message', `Failed to save solution: ${e.message}`);
//     return {success: false, error: e.message};
//   }
// });

// ─── DeepSeek bridge: renderer -> main (via Cloudflare Worker) ──────────────
ipcMain.handle('deepseek:ask', async (_evt, prompt) => {
  // The URL of the deployed Cloudflare Worker
  const WORKER_URL = 'https://poker-deepseek.pokersolver.workers.dev';

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({prompt: prompt}),
    });

    if (!res.ok) {
      let errorText = `Worker returned status ${res.status}`;
      try {
        errorText = await res.text();
      } catch (e) {
      }

      console.error(`Error from Worker (${res.status}): ${errorText}`);
      throw new Error(`API request via Worker failed: ${res.status} ${
          res.statusText}. Details: ${errorText}`);
    }

    const data = await res.json();

    if (data.choices && data.choices.length > 0 && data.choices[0].message) {
      return data.choices[0].message.content.trim();
    } else {
      console.error(
          'Unexpected response structure received from Worker:', data);
      throw new Error(
          'Received an unexpected response structure from the API proxy.');
    }

  } catch (error) {
    console.error(
        'Error communicating with Worker or processing response:', error);
    throw new Error(`Failed to get response from AI: ${error.message}`);
  }
});

// IPC handler to open the solver window after successful login.
ipcMain.handle('open-solver-window', () => {
  if (loginWindow) {
    loginWindow.close();
  }
  createSolverWindow();
  return {success: true};
});

// IPC handler to get the stored NetID for the solver window.
ipcMain.handle('get-netid', () => {
  return global.sharedObject && global.sharedObject.netid ?
      global.sharedObject.netid :
      '';
});

ipcMain.handle('apply-flop-board', async (event, flopBoard) => {
  const cards = flopBoard.split(',').map(c => c.trim()).filter(Boolean);
  if (cards.length !== 3) {
    return {success: false, error: 'Exactly 3 cards must be selected.'};
  }

  try {
    const content = fs.readFileSync(INPUT_JSON_PATH, 'utf8');
    let config = JSON.parse(content);

    const transformedCards = cards.map(card => {
      const rank = card.slice(0, -1);
      const suitUnicode = card.slice(-1);
      const suitLetter =
          suitMapping[suitUnicode] || suitUnicode;  // Use existing suitMapping
      // Ensure canonical hand format like Ac, Kd, Qs
      return rank.toUpperCase() + suitLetter.toLowerCase();
    });

    if (!config.gameSetup) config.gameSetup = {};
    config.gameSetup.board = transformedCards;  // Update the board array

    fs.writeFileSync(INPUT_JSON_PATH, JSON.stringify(config, null, 2), 'utf8');
    return {success: true, message: 'Flop board applied successfully.'};
  } catch (err) {
    console.error('Error applying flop board:', err);
    return {success: false, error: err.message};
  }
});

// IPC handler to run the solver on the remote host.
ipcMain.handle('run-solver', async (event, netid) => {
  console.log('Received run-solver request with netid:', netid);
  const sendProgress = (msg) => event.sender.send('progress-update', msg);

  if (!netid || typeof netid !== 'string') {
    sendProgress('Invalid netID provided.');
    return {success: false, error: 'Invalid netID provided.'};
  }

  const remoteHost = 'node.zoo.cs.yale.edu';
  const sshUserHost = `${netid}@${remoteHost}`;
  const remoteDir = '~/yale-poker';
  const remoteDbPath = `${remoteDir}/output_result.msgpack.sqlite`;

  const localInstallDirForRsync = OPERATIONAL_INSTALL_DIR;
  const localQueryScriptForRsync = OPERATIONAL_QUERY_SCRIPT;

  // --- Ensure previous data sources are closed ---
  LZ.close();
  SQLZ.close();
  currentDataSource = 'none';

  sendProgress('Copying solver and query script to the Zoo...');
  const rsyncUploadCmd = `rsync -avz --delete "${localInstallDirForRsync}/" "${
      localQueryScriptForRsync}" ${sshUserHost}:${remoteDir}/`;

  try {
    if (!fs.existsSync(localInstallDirForRsync) ||
        !fs.existsSync(localQueryScriptForRsync)) {
      throw new Error(`Operational solver files not found in userData at ${
          localInstallDirForRsync}. Initialization might have failed.`);
    }
    await execPromise(rsyncUploadCmd, {timeout: 60000});
    sendProgress('Upload complete.');
  } catch (uploadErr) {
    return {success: false, error: `Upload error: ${uploadErr.message}`};
  }

  sendProgress('Running solver on the Zoo...');
  const remoteCommand = [
    `cd ${remoteDir}`, 'chmod +x console_solver query_solver_db.py',
    './console_solver -i resources/text/input.json'
  ].join(' && ');

  try {
    await execPromise(
        `ssh ${SSH_OPTIONS} ${sshUserHost} '${remoteCommand}'`,
        {timeout: 6000000}  // Long timeout for solver
    );
    sendProgress('Solver execution completed.');
  } catch (solverErr) {
    console.error('Error running solver:', solverErr.message);
    sendProgress('Solver execution failed: ' + solverErr.message);
    // Attempt cleanup even if solver fails
    try {
      await execPromise(
          `ssh ${SSH_OPTIONS} ${sshUserHost} "rm -rf ${remoteDir}"`);
    } catch (cleanupErr) {
      console.error('Remote cleanup failed after solver error:', cleanupErr);
    }
    return {
      success: false,
      error: `Solver execution error: ${solverErr.message}`
    };
  }

  sendProgress('Initializing remote SQL connection...');
  let rootObj;
  try {
    // Initialize SQLZ with the remote DB path and user@host
    rootObj = await SQLZ.init(remoteDbPath, sshUserHost);
    currentDataSource = 'sqlz';  // Set state to SQLZ
    console.log('SQLZ initialized, root node:', rootObj);
  } catch (sqlzInitErr) {
    console.error('SQLZ Initialization Error:', sqlzInitErr.message);
    sendProgress(
        'Failed to initialize remote connection: ' + sqlzInitErr.message);
    try {
      await execPromise(
          `ssh ${SSH_OPTIONS} ${sshUserHost} "rm -rf ${remoteDir}"`);
    } catch (cleanupErr) {
      console.error('Remote cleanup failed after SQLZ init error:', cleanupErr);
    }
    return {success: false, error: `SQLZ Init Error: ${sqlzInitErr.message}`};
  }

  // Fetch flop data from the local input.json used for the run.
  let flopBoard = [];  // Expecting ["Ac", "Kd", "Qs"] format
  let flopError = null;
  try {
    const content = fs.readFileSync(INPUT_JSON_PATH, 'utf8');
    const config = JSON.parse(content);
    flopBoard = config?.gameSetup?.board || [];
    if (!Array.isArray(flopBoard) || flopBoard.length !== 3) {
      flopError = 'Invalid or missing board array in input JSON.';
      flopBoard = [];
    }
  } catch (e) {
    flopError = `Error reading input JSON: ${e.message}`;
  }

  event.sender.send('root-tree', {root: rootObj, flop: flopBoard});

  sendProgress('Solver run and remote connection successful.');
  return {success: true, flop: flopBoard, flopError: flopError};
});


ipcMain.handle('apply-configurations', async (event, newConfigValues) => {
  try {
    const content = fs.readFileSync(INPUT_JSON_PATH, 'utf8');
    let config = JSON.parse(content);

    for (const pathString in newConfigValues) {
      const value = newConfigValues[pathString];
      const keys = pathString.split(
          '.');  // e.g., ['betSizing', 'outOfPosition', 'flop', '0', 'sizes']
      let current = config;
      let navigationOk = true;  // Flag

      const stopDepth = pathString.startsWith('betSizing.') ? keys.length - 2 :
                                                              keys.length - 1;

      for (let i = 0; i < stopDepth; i++) {
        // Ensure parent exists before diving deeper
        if (!current || typeof current !== 'object') {
          console.warn(
              `Navigation failed at key '${keys[i]}' (index ${i}) for path ${
                  pathString}. Parent was:`,
              current);
          navigationOk = false;
          break;
        }
        current = current[keys[i]];  // Navigate one level down
      }
      if (!navigationOk || !current) {
        console.warn(`Could not resolve navigation path for ${
            pathString}. Skipping update.`);
        continue;  // Skip to next pathString
      }

      const finalKey = keys[keys.length - 1];

      if (pathString.startsWith('betSizing.')) {
        const indexKey =
            keys[keys.length - 2];  // The index key (e.g., "0", "1")
        const targetIndex = parseInt(indexKey);

        if (Array.isArray(current) && !isNaN(targetIndex) && targetIndex >= 0 &&
            targetIndex < current.length) {
          const targetObject = current[targetIndex];

          // Validate targetObject and that we are updating 'sizes'
          if (typeof targetObject === 'object' && targetObject !== null &&
              finalKey === 'sizes') {
            const sizeValues = value.split(',')
                                   .map(s => s.trim())
                                   .map(Number)
                                   .filter(n => !isNaN(n));
            targetObject.sizes = sizeValues;
          } else {
            console.warn(
                `Invalid target object or final key for bet sizing path: ${
                    pathString}. Expected object with 'sizes' key. Found:`,
                targetObject);
          }
        } else {
          console.warn(`Could not find valid bet size action object for path ${
              pathString}. Skipping.`);
          if (!Array.isArray(current))
            console.warn(`Reason: 'current' is not an array.`);
          else if (isNaN(targetIndex))
            console.warn(
                `Reason: Extracted index key '${indexKey}' is not a number.`);
          else if (!current[targetIndex])
            console.warn(`Reason: Index ${
                targetIndex} is out of bounds for array of length ${
                current.length}.`);
        }
      } else if (
          pathString === 'gameSetup.pot' ||
          pathString === 'gameSetup.effectiveStack' ||
          pathString.startsWith('solverSettings.')) {
        if (typeof value === 'string' || typeof value === 'number') {
          const numValue = parseFloat(value);
          if (!isNaN(numValue)) {
            current[finalKey] = numValue;
          } else {
            console.warn(`Invalid number format for ${pathString}: ${
                value}. Skipping update.`);
          }
        } else if (typeof value === 'boolean') {
          current[finalKey] = value;
        } else {
          console.warn(`Unexpected value type for numeric/boolean path ${
              pathString}: ${typeof value}. Skipping.`);
        }

      } else {
        if (typeof value === 'string') {
          current[finalKey] = value;
        } else {
          console.warn(`Unexpected value type for string path ${pathString}: ${
              typeof value}. Skipping.`);
        }
      }
    }

    fs.writeFileSync(INPUT_JSON_PATH, JSON.stringify(config, null, 2), 'utf8');
    return {success: true, message: 'Configurations applied successfully.'};
  } catch (err) {
    console.error('Error applying configurations:', err);
    return {success: false, error: err.message};
  }
});

ipcMain.handle('run-equity', async (event, turnSelection, riverSelection) => {
  const netid = global.sharedObject.netid;
  const sendProgress = msg => event.sender.send('progress-update', msg);

  try {
    await computeEquityInBackground(
        netid, turnSelection, riverSelection, sendProgress);
    sendProgress('Equity update completed.');
    return {success: true};
  } catch (err) {
    sendProgress('Equity update failed: ' + err.message);
    return {success: false, error: err.message};
  }
});

function extractRangesAndBoard() {
  try {
    const content = fs.readFileSync(INPUT_JSON_PATH, 'utf8');
    const config = JSON.parse(content);

    const ipRange = config?.playerRanges?.inPosition || '';
    const oopRange = config?.playerRanges?.outOfPosition || '';
    const boardArray = config?.gameSetup?.board || [];
    // Join array elements like ["Ac", "Kd", "Qs"] into "AcKdQs"
    const board = boardArray.join('');

    return {ipRange, oopRange, board};
  } catch (err) {
    console.error('Error extracting ranges and board from JSON:', err);
    return {ipRange: '', oopRange: '', board: ''};  // Return defaults on error
  }
}

async function computeEquityInBackground(
    netid, turnSelection, riverSelection, sendProgress) {
  const remoteHost = 'node.zoo.cs.yale.edu';
  const remoteDir = '~/equity_calculator';

  // Use the OPERATIONAL path in userData as the source for rsync
  const localEquitySourceDir = OPERATIONAL_EQUITY_DIR;
  // Use the dedicated download directory in userData for results
  const localEquityDownloadDir = LOCAL_EQUITY_DOWNLOAD_DIR;

  // Ensure the source directory exists
  if (!fs.existsSync(localEquitySourceDir)) {
    const errorMsg = `Equity calculator directory not found in userData: ${
        localEquitySourceDir}. Initialization may have failed.`;
    console.error(errorMsg);
    sendProgress(errorMsg);
    throw new Error(errorMsg);
  }
  fs.mkdirSync(
      localEquityDownloadDir,
      {recursive: true});  // Ensure it exists, harmless if already there

  const {ipRange, oopRange, board} = extractRangesAndBoard();

  // 1) Upload from userData
  sendProgress('Uploading equity calculator (from userData) to the Zoo...');
  try {
    await execPromise(`rsync -avz --delete "${localEquitySourceDir}/" ${
        netid}@${remoteHost}:${remoteDir}/`);
    sendProgress('Synchronization complete.');
  } catch (syncError) {
    console.error('Error during rsync:', syncError);
    sendProgress('Error during synchronization: ' + syncError.message);
    throw syncError;
  }

  // 2) Run equity_grid.sh (Remote command logic remains the same)
  let eqCmd = `./equity_grid.sh "${ipRange}" "${oopRange}" "${board}"`;
  console.log(
      'turnSelection=', turnSelection, ' riverSelection=', riverSelection);
  if (turnSelection) eqCmd += ` "${turnSelection}"`;
  if (riverSelection) eqCmd += ` "${riverSelection}"`;
  const remoteCmd = `cd ${remoteDir} && ${eqCmd}`;
  sendProgress('Running equity calculations on the Zoo...');
  try {  // Add try-catch for SSH command
    await execPromise(
        `ssh -t -o BatchMode=yes ${netid}@${remoteHost} "${remoteCmd}"`,
        {timeout: 900000});
  } catch (sshError) {
    console.error('Error running remote equity calculation:', sshError);
    sendProgress('Error during remote equity calculation: ' + sshError.message);
    try {
      await execPromise(`ssh -t -o BatchMode=yes ${netid}@${
          remoteHost} "rm -rf ${remoteDir}"`);
    } catch (cleanupErr) {
      console.error('Remote cleanup failed after SSH error:', cleanupErr);
    }
    throw sshError;
  }

  // 3) Download results to userData/equity_results_temp
  sendProgress('Downloading equity results...');
  const gzPhases = ['flop'];
  if (turnSelection) gzPhases.push('turn');
  if (riverSelection) gzPhases.push('river');
  const results = {};
  const {gunzipSync} = require('zlib');
  try {
    for (const phase of gzPhases) {
      const remoteFile = `${remoteDir}/equity_${phase}.msgpack.gz`;
      const localFile =
          path.join(localEquityDownloadDir, `equity_${phase}.msgpack.gz`);

      await execPromise(
          `scp -C ${netid}@${remoteHost}:${remoteFile} "${localFile}"`);

      const raw = gunzipSync(fs.readFileSync(localFile));
      const obj = msgpack.decode(raw) || {};
      results[phase] = {hero: obj.hero || {}, villain: obj.villain || {}};
    }
  } catch (downloadError) {
    console.error(
        'Error during equity results download/processing:', downloadError);
    sendProgress(
        'Error downloading/processing results: ' + downloadError.message);
    try {
      await execPromise(`ssh -t -o BatchMode=yes ${netid}@${
          remoteHost} "rm -rf ${remoteDir}"`);
    } catch (cleanupErr) {
      console.error('Remote cleanup failed after download error:', cleanupErr);
    }
    throw downloadError;
  }

  // 4) Broadcast to all windows
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('equity-data', results);
  });

  // 5) Cleanup remote
  try {
    await execPromise(
        `ssh -t -o BatchMode=yes ${netid}@${remoteHost} "rm -rf ${remoteDir}"`);
  } catch (cleanupError) {
    console.error('Error cleaning up remote directory:', cleanupError);
    sendProgress(
        'Warning: Failed to clean up remote directory: ' +
        cleanupError.message);
  }
}


function createRangeEditorWindow(rangeType, initialRangeString) {
  if (rangeEditorWindow && !rangeEditorWindow.isDestroyed()) {
    rangeEditorWindow.focus();
    return;
  }
  rangeEditorWindow = new BrowserWindow({
    width: 650,
    height: 800,
    title: `Edit ${rangeType.toUpperCase()} Range`,
    parent: configWindow || solverWindow,  // Or whichever is the parent
    modal: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true  // Keep dev tools for debugging if needed
    }
  });

  rangeEditorWindow.loadFile('range_editor.html');

  // Send initial data AFTER the window is ready
  rangeEditorWindow.webContents.once('did-finish-load', () => {
    rangeEditorWindow.webContents.send(
        'initial-range-data', {rangeType, initialRangeString});
  });

  rangeEditorWindow.on('closed', () => {
    rangeEditorWindow = null;
  });
}

// Add with other ipcMain.handle calls
ipcMain.handle(
    'open-range-editor', (event, {rangeType, initialRangeString}) => {
      const parentWindow = BrowserWindow.fromWebContents(
          event.sender);  // Get the window that sent the request
      if (!parentWindow)
        return {success: false, error: 'Could not determine parent window.'};

      createRangeEditorWindow(rangeType, initialRangeString);
      return {success: true};
    });

// Add with other ipcMain.handle calls
ipcMain.handle(
    'apply-range-string', async (event, {rangeType, rangeString}) => {
      try {
        const content = fs.readFileSync(INPUT_JSON_PATH, 'utf8');
        let config = JSON.parse(content);

        if (!config.playerRanges) config.playerRanges = {};

        const keyToUpdate = rangeType === 'ip' ? 'inPosition' : 'outOfPosition';
        config.playerRanges[keyToUpdate] = rangeString;

        fs.writeFileSync(
            INPUT_JSON_PATH, JSON.stringify(config, null, 2), 'utf8');

        // Notify the config window to update its input field value
        if (configWindow && !configWindow.isDestroyed()) {
          configWindow.webContents.send(
              'update-config-range-field', {rangeType, rangeString});
        }

        return {
          success: true,
          message: `${rangeType.toUpperCase()} range updated successfully.`
        };
      } catch (err) {
        console.error(`Error updating ${rangeType} range:`, err);
        return {
          success: false,
          error: `Failed to update ${rangeType} range: ${err.message}`
        };
      }
    });


/// IPC handler to lazily load a subtree based on the current data source.
ipcMain.handle('lazy:subtree', async (_evt, path) => {
  try {
    let data;
    console.log(`[IPC lazy:subtree] Handling request for path "${
        path}". Current data source: ${currentDataSource}`);

    if (currentDataSource === 'sqlz') {
      if (!SQLZ.isActive()) {
        console.error(
            `[IPC lazy:subtree] Error: SQLZ source selected but not active for path "${
                path}".`);
        throw new Error('SQLZ is not active. Cannot fetch subtree.');
      }
      data = await SQLZ.subtree(path);
    } else if (currentDataSource === 'lz') {
      console.log(`[IPC lazy:subtree] Using LZ for path "${path}"`);
      if (!LZ.subtree) {  // Simple check if LZ seems initialized
        console.error(
            `[IPC lazy:subtree] Error: LZ source selected but not initialized for path "${
                path}".`);
        throw new Error(
            'LZ is not active or initialized. Load a sample solution first.');
      }
      data = LZ.subtree(path);  // LZ.subtree is sync
    } else {
      console.error(
          `[IPC lazy:subtree] Error: No active data source for path "${
              path}" (currentDataSource=${currentDataSource})`);
      throw new Error('No active data source (LZ or SQLZ) is initialized.');
    }

    if (data === null) {
      console.warn(`[IPC lazy:subtree] Returning null data for path "${
          path}" from ${
          currentDataSource}. Check previous SQLZ logs for details if error.`);
      return {
        ok: false,
        error: `Data unavailable or fetch failed for path: ${path}`
      };
    } else if (data === undefined) {
      console.error(`[IPC lazy:subtree] Returning UNDEFINED data for path "${
          path}" from ${currentDataSource}. This is unexpected.`);
      return {
        ok: false,
        error: `Received unexpected undefined data for path: ${path}`
      };
    }
    return {ok: true, data};

  } catch (e) {
    console.error(
        `[IPC lazy:subtree] CRITICAL ERROR fetching path "${path}" using ${
            currentDataSource}:`,
        e);
    return {ok: false, error: e.message};
  }
});


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    console.log('All windows closed; quitting app.');
    app.quit();
  }
});

// Solver config window
let configWindow;

function createConfigWindow() {
  configWindow = new BrowserWindow({
    width: 600,
    height: 500,
    title: 'Customize Input File',
    parent: solverWindow,  // make it modal relative to the solver window
    modal: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  configWindow.loadFile('config.html');
  configWindow.on('closed', () => {
    configWindow = null;
  });
}

ipcMain.handle('open-config-window', () => {
  if (!configWindow) {
    createConfigWindow();
  } else {
    configWindow.focus();
  }
  return {success: true};
});

ipcMain.handle('get-config-data', async () => {
  try {
    const content = fs.readFileSync(INPUT_JSON_PATH, 'utf8');
    const config = JSON.parse(content);
    return {success: true, data: config};  // Return the parsed JSON object
  } catch (err) {
    console.error('Error in get-config-data:', err);
    return {success: false, error: err.message};
  }
});

ipcMain.handle('load-configuration', async () => {
  try {
    const content = fs.readFileSync(INPUT_JSON_PATH, 'utf8');
    const config = JSON.parse(content);
    return {success: true, data: config};  // Return the parsed JSON object
  } catch (err) {
    console.error('Error in load-configuration:', err);
    return {success: false, error: err.message};
  }
});