// ==UserScript==
// @name         WME BDP Check
// @namespace    https://greasyfork.org/users/166843
// @version      2026.06.26.00
// @description  Check for possible BDP routes between two selected segments.
// @author       dBsooner
// @match        *://*.waze.com/*editor*
// @exclude      *://*.waze.com/user/editor*
// @exclude      *://*.waze.com/editor/sdk/*
// @require      https://greasyfork.org/scripts/509664/code/WME%20Utils%20-%20Bootstrap.js
// @require      https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @grant        GM_xmlhttpRequest
// @license      GPLv3
// @connect      greasyfork.org
// @connect      waze.com

// ==/UserScript==

/* global GM_info, GM_xmlhttpRequest, WazeWrap, bootstrap*/

(async function () {
  'use strict';

  // ═════════════════════════════════════════════════════════════════════════════════════
  // SETUP
  // ═════════════════════════════════════════════════════════════════════════════════════

  // ── Script metadata ──────────────────────────────────────────────────────────────────
  const _SCRIPT_SHORT_NAME = 'WME BDPC';
  const _SCRIPT_LONG_NAME = GM_info.script.name;
  const _SCRIPT_AUTHOR = GM_info.script.author;
  const _SCRIPT_VERSION = GM_info.script.version;
  const _SETTINGS_STORE_NAME = 'WMEBDPC';
  const _LOAD_BEGIN_TIME = performance.now();
  const _DEBUG = false; // Set to false before release
  const _DOWNLOAD_URL = 'https://greasyfork.org/scripts/393407-wme-bdp-check/code/WME%20BDP%20Check.user.js'; // need to update once GF URL is updated.
  const _SHOW_UPDATE_MESSAGE = true;
  const _SCRIPT_VERSION_CHANGES = ['MIGRATION: Updated to WME SDK!'];

  // ── Global SDK instance assigned by bootstrap() ──────────────────────────────────────
  let wmeSdk; // WME SDK - initialized by bootstrap()
  let _settings = {};

  // ── Runtime state ─────────────────────────────────────────────────────────────────────
  let _pathEndSegId;
  let _restoreZoomLevel;
  let _restoreMapCenter;

  // ── Element cache ─────────────────────────────────────────────────────────────────────
  const _elems = {
    div: document.createElement('div'),
    'wz-button': document.createElement('wz-button'),
    'wz-card': document.createElement('wz-card'),
  };
  const _timeouts = { saveSettingsToStorage: undefined };
  let _bdpCheckButton = null;
  let _bdpCheckViaLMButton = null;

  // ── Logging utilities ───────────────────────────────────────────────────────────────
  function log(message, data = '') {
    console.log(`${_SCRIPT_SHORT_NAME}:`, message, data);
  }

  function logError(message, data = '') {
    console.error(`${_SCRIPT_SHORT_NAME}:`, new Error(message), data);
  }

  function logWarning(message, data = '') {
    console.warn(`${_SCRIPT_SHORT_NAME}:`, message, data);
  }

  function logDebug(message, data = '') {
    if (_DEBUG) {
      log(message, data);
    }
  }

  // ── Object extend utility (like jQuery.extend) ──────────────────────────────────────
  function $extend(...args) {
    const extended = {};
    const deep = Object.prototype.toString.call(args[0]) === '[object Boolean]' ? args[0] : false;
    const merge = function (obj) {
      Object.keys(obj).forEach((prop) => {
        if (Object.prototype.hasOwnProperty.call(obj, prop)) {
          if (deep && Object.prototype.toString.call(obj[prop]) === '[object Object]') {
            extended[prop] = $extend(true, extended[prop], obj[prop]);
          } else if (obj[prop] !== undefined && obj[prop] !== null) {
            extended[prop] = obj[prop];
          }
        }
      });
    };
    for (let i = deep ? 1 : 0, { length } = args; i < length; i++) {
      if (args[i]) {
        merge(args[i]);
      }
    }
    return extended;
  }

  // ── DOM element creation utility ────────────────────────────────────────────────────
  function createElem(type = '', attrs = {}, eventListener = []) {
    const el = _elems[type]?.cloneNode(false) || _elems.div.cloneNode(false);
    const applyEventListeners = function ([evt, cb]) {
      return this.addEventListener(evt, cb);
    };
    Object.keys(attrs).forEach((attr) => {
      if (attrs[attr] !== undefined && attrs[attr] !== 'undefined' && attrs[attr] !== null && attrs[attr] !== 'null') {
        if (attr === 'textContent' || attr === 'innerHTML') {
          el[attr] = attrs[attr];
        } else if (attr === 'disabled' || attr === 'checked' || attr === 'selected') {
          // For web components, set both property AND attribute to ensure proper state
          el[attr] = attrs[attr];
          if (attrs[attr] === true) {
            el.setAttribute(attr, '');
          } else if (attrs[attr] === false) {
            el.removeAttribute(attr);
          }
        } else {
          el.setAttribute(attr, attrs[attr]);
        }
      }
    });
    if (eventListener.length > 0) {
      eventListener.forEach((obj) => {
        Object.entries(obj).map(applyEventListeners.bind(el));
      });
    }
    return el;
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // SETTINGS MANAGEMENT (localStorage)
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * Load settings from localStorage (no WazeWrap.Remote)
   * @returns {Promise<void>}
   */
  function loadSettingsFromStorage() {
    const defaultSettings = {
      lastSaved: 0,
      lastVersion: undefined,
    };
    const stored = localStorage.getItem(_SETTINGS_STORE_NAME);
    const loadedSettings = stored ? JSON.parse(stored) : {};
    _settings = $extend(true, {}, defaultSettings, loadedSettings);

    if (_timeouts.saveSettingsToStorage) {
      window.clearTimeout(_timeouts.saveSettingsToStorage);
    }
    _timeouts.saveSettingsToStorage = window.setTimeout(saveSettingsToStorage, 5000);

    return Promise.resolve();
  }

  /**
   * Save settings to localStorage only
   */
  function saveSettingsToStorage() {
    if (_timeouts.saveSettingsToStorage) {
      window.clearTimeout(_timeouts.saveSettingsToStorage);
      _timeouts.saveSettingsToStorage = undefined;
    }
    if (localStorage) {
      _settings.lastVersion = _SCRIPT_VERSION;
      _settings.lastSaved = Date.now();
      localStorage.setItem(_SETTINGS_STORE_NAME, JSON.stringify(_settings));
      logDebug('Settings saved to localStorage.');
    }
  }

  /**
   * Displays the WazeWrap "script updated" notification banner when the script version changes.
   *
   * Compares `SCRIPT_VERSION` against the `lastVersion` value stored in `options`.  If they
   * differ (and `SHOW_UPDATE_MESSAGE` is true) it calls `WazeWrap.Interface.ShowScriptUpdate`
   * with the current release notes built from `SCRIPT_VERSION_CHANGES`, then updates
   * `lastVersion` and persists it to `localStorage` so the banner is not shown
   * again on the next page load.
   *
   */
  function showScriptInfoAlert() {
    /* Check version and alert on update */
    if (_SHOW_UPDATE_MESSAGE && _SCRIPT_VERSION !== _settings['lastVersion']) {
      let releaseNotes = '';
      releaseNotes += "<p>What's New:</p>";
      if (_SCRIPT_VERSION_CHANGES.length > 0) {
        releaseNotes += '<ul>';
        for (let idx = 0; idx < _SCRIPT_VERSION_CHANGES.length; idx++) releaseNotes += `<li>${_SCRIPT_VERSION_CHANGES[idx]}</li>`;
        releaseNotes += '</ul>';
      } else {
        releaseNotes += '<ul><li>Nothing major.</li></ul>';
      }
      WazeWrap.Interface.ShowScriptUpdate(_SCRIPT_LONG_NAME, _SCRIPT_VERSION, releaseNotes, _DOWNLOAD_URL);

      _settings['lastVersion'] = _SCRIPT_VERSION;
      if (localStorage) {
        saveSettingsToStorage();
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // REPORT CARD DATA STRUCTURE
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * @typedef {Object} BDPReportCard
   * @property {string} mode - 'MODE_1' or 'MODE_2' or 'ERROR'
   * @property {string} verdict - 'BDP_WILL_APPLY' | 'BDP_WONT_APPLY' | 'ERROR'
   * @property {string} verdictMessage - Human-readable verdict (e.g., "BDP will be applied")
   * @property {Array<Object>} tests - Array of test results
   * @property {string} tests[].name - Test name (e.g., "NAME CONTINUITY")
   * @property {boolean} tests[].passed - Whether test passed
   * @property {string} tests[].explanation - Short explanation of result
   * @property {Object|null} directRoute - Found direct route, if any
   * @property {number[]} directRoute.segmentIds - IDs of direct route segments
   * @property {number} directRoute.length - Total length in meters
   * @property {Array<string>} directRoute.streetNames - Street names in route
   */

  /**
   * Create empty report card (for error states)
   * @returns {BDPReportCard}
   */
  /**
   * Get human-readable verdict message from verdict code
   * @param {string} verdict - 'BDP_WILL_APPLY' | 'BDP_WONT_APPLY' | 'ERROR'
   * @param {string} mode - 'MODE_1' or 'MODE_2'
   * @returns {string}
   */
  function getVerdictMessage(verdict, mode) {
    if (verdict === 'BDP_WILL_APPLY') {
      if (mode === 'MODE_1') {
        return 'Valid direct route exists — BDP will protect against detours';
      }
      return 'BDP will be applied to this detour route';
    }
    if (verdict === 'BDP_WONT_APPLY') {
      if (mode === 'MODE_1') {
        return 'No valid direct route found — BDP cannot be applied';
      }
      return 'BDP will NOT be applied — detour is not a valid route';
    }
    return 'Unable to determine result';
  }

  /**
   * Build BDP report card from check results
   * Called at the END of doCheckBDP after all checks complete
   * @param {Object} checkResults - Results from check (passed to this function by doCheckBDP)
   * @param {string} checkResults.mode - 'MODE_1' or 'MODE_2'
   * @param {Array<Object>} checkResults.testResults - Array of { name, passed, explanation }
   * @param {string} checkResults.verdict - Final verdict
   * @param {string} checkResults.verdictMessage - Verdict explanation
   * @param {Object|null} checkResults.directRoute - Direct route if found
   * @returns {BDPReportCard}
   */
  function buildBDPReport(checkResults) {
    if (!checkResults) {
      return {
        mode: 'ERROR',
        verdict: 'ERROR',
        verdictMessage: 'No check performed',
        tests: [],
        directRoute: null,
      };
    }

    return {
      mode: checkResults.mode || 'ERROR',
      verdict: checkResults.verdict || 'ERROR',
      verdictMessage: checkResults.verdictMessage || 'Unknown result',
      tests: checkResults.testResults || [],
      directRoute: checkResults.directRoute || null,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // REPORT CARD HTML RENDERING
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * Render report card to HTML
   * @param {BDPReportCard} report - Report card object
   * @returns {string} HTML string
   */
  function renderReportCardHTML(report) {
    if (report.verdict === 'ERROR') {
      return `
        <div class="bdc-card">
          <div class="bdc-card-header">
            <i class="fa fa-exclamation-circle"></i>
            <span>Check Error</span>
          </div>
          <div class="bdc-card-body" style="padding: 10px;">
            <p style="margin: 0; font-size: 11px; color: #666;">${escapeHTML(report.verdictMessage)}</p>
          </div>
        </div>
      `;
    }

    // Build verdict section (with support for inconclusive)
    let verdictClass = 'bdc-verdict-no';
    let verdictEmoji = '🚫';
    let verdictIcon = 'fa-times-circle';
    if (report.verdict === 'BDP_WILL_APPLY') {
      verdictClass = 'bdc-verdict-yes';
      verdictEmoji = '📍';
      verdictIcon = 'fa-check-circle';
    } else if (report.verdict === 'INCONCLUSIVE' || report.tests?.some((t) => t.passed === 'inconclusive')) {
      verdictClass = 'bdc-verdict-inconclusive';
      verdictEmoji = '⚠️';
      verdictIcon = 'fa-exclamation-triangle';
    }

    // Build test results HTML (with support for inconclusive state)
    const testsHTML = report.tests
      .map((test) => {
        let icon = '❌';
        if (test.passed === true) {
          icon = '✅';
        } else if (test.passed === 'inconclusive') {
          icon = '⚠️';
        }
        return `
        <div class="bdc-test-result">
          <span class="bdc-test-icon">${icon}</span>
          <span class="bdc-test-name">${escapeHTML(test.name)}</span>
          <span class="bdc-test-explanation">${escapeHTML(test.explanation)}</span>
        </div>
      `;
      })
      .join('');

    // Build direct route link if applicable
    let directRouteHTML = '';
    if (report.directRoute && report.directRoute.segmentIds && report.directRoute.segmentIds.length > 0) {
      const routeLength = (report.directRoute.length / 1000).toFixed(2);
      const routeDataJson = JSON.stringify(report.directRoute);
      const routeDataAttr = escapeHTML(routeDataJson);
      directRouteHTML = `
        <div class="bdc-row" style="flex-direction: column; gap: 8px; align-items: flex-start;">
          <div style="font-weight: 600; font-size: 11px;">Direct Route: ${report.directRoute.segmentIds.length} segs, ${routeLength} km</div>
          <wz-button color="primary" size="sm" class="bdc-show-route-btn" data-route='${routeDataAttr}'>Show on Map</wz-button>
        </div>
      `;
    }

    return `
      <div class="bdc-card">
        <div class="bdc-card-header">
          <i class="fa ${verdictIcon}"></i>
          <span>Report (${escapeHTML(report.mode)})</span>
        </div>
        <div class="bdc-card-body">
          <div class="bdc-verdict-box ${verdictClass}">
            <span class="bdc-verdict-emoji">${verdictEmoji}</span>
            <span class="bdc-verdict-text">${escapeHTML(report.verdictMessage)}</span>
          </div>
          <div style="border-top: 1px solid var(--hairline, #f0f0f0);">
            <div style="padding: 8px 10px; font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: #666;">Tests</div>
            ${testsHTML}
          </div>
          ${directRouteHTML ? `<div style="border-top: 1px solid var(--hairline, #f0f0f0);">${directRouteHTML}</div>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Global event listener for "Show Direct Route" buttons
   * Triggered when user clicks button in report card
   * showDirectRouteFromReport() is defined in Task 4
   */
  document.addEventListener('click', function (e) {
    if (e.target.classList.contains('bdc-show-route-btn')) {
      const routeDataJson = e.target.dataset.route;
      if (routeDataJson) {
        try {
          const directRoute = JSON.parse(routeDataJson);
          if (typeof showDirectRouteFromReport !== 'undefined') {
            showDirectRouteFromReport(directRoute);
          }
        } catch (err) {
          console.error('[BDP Check] Failed to parse route data:', err);
        }
      }
    }
  });

  /**
   * Escape HTML to prevent injection
   * @param {string} text
   * @returns {string}
   */
  function escapeHTML(text) {
    if (!text) return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * Show the direct route segments on the map when user clicks "Show Direct Route" button
   * Matches behavior of "Yes" in the direct route confirmation alert:
   * - Selects the route segments
   * - Restores original zoom level (doesn't zoom in to view route)
   * @param {Object} directRoute - Route object from report { segmentIds, length, streetNames }
   */
  async function showDirectRouteFromReport(directRoute) {
    if (!directRoute || !directRoute.segmentIds || directRoute.segmentIds.length === 0) {
      logWarning('showDirectRouteFromReport: No direct route to display');
      return;
    }

    try {
      // Select all segments in the direct route (matches line 1301-1305 in alert handler)
      wmeSdk.Editing.setSelection({
        selection: {
          objectType: 'segment',
          ids: directRoute.segmentIds,
        },
      });

      // Restore original zoom level (matches line 1307 in alert handler)
      await doZoom(true, _restoreZoomLevel, _restoreMapCenter);

      logDebug(`showDirectRouteFromReport: Selected ${directRoute.segmentIds.length} segments and restored zoom`);
    } catch (err) {
      logError('showDirectRouteFromReport error:', err);
    }
  }

  /**
   * Get the report container element (creates if missing)
   * Used by Task 6 to display report card HTML
   * Returns null if container cannot be created/found
   * @returns {HTMLElement|null}
   */
  function getReportContainer() {
    let container = document.getElementById('bdc-report-container');
    if (!container) {
      // Create container if it doesn't exist
      container = createElem('div', {
        id: 'bdc-report-container',
        className: 'bdc-report-container',
      });
      const bdcTab = document.getElementById('bdc-check-tab');
      if (!bdcTab) {
        console.warn('[BDP Check] BDP tab not found; report container created but not attached to DOM');
        return null;
      }
      bdcTab.appendChild(container);
    }
    return container;
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS (pure math)
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * Get the middle coordinate of a coordinate array
   * Returns null for empty arrays
   */
  function findMiddle(coordinates) {
    if (!coordinates?.length) return null;
    return coordinates[Math.floor(coordinates.length / 2)];
  }

  /**
   * Calculate the geographic midpoint between the centers of two segments.
   * Uses simple WGS84 averaging - sufficient for small distances at map zoom levels.
   *
   * @param {Object} startSeg - Segment with geometry.coordinates (GeoJSON LineString)
   * @param {Object} endSeg   - Segment with geometry.coordinates (GeoJSON LineString)
   * @returns {{ lon: number, lat: number } | null}
   */
  function getMidpoint(startSeg, endSeg) {
    const startCoords = startSeg?.geometry?.coordinates;
    const endCoords = endSeg?.geometry?.coordinates;

    const startCenter = findMiddle(startCoords);
    const endCenter = findMiddle(endCoords);

    // Validate before doing any math
    if (!startCenter || !endCenter) {
      logError('getMidpoint: missing or empty coordinates', { startCoords, endCoords });
      return startCenter ? { lon: startCenter[0], lat: startCenter[1] } : null;
    }

    // Simple average is accurate enough for short inter-segment distances.
    const lon = (startCenter[0] + endCenter[0]) / 2;
    const lat = (startCenter[1] + endCenter[1]) / 2;

    logDebug(`getMidpoint: [${lon}, ${lat}]`);

    return { lon, lat };
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // SDK HELPER FUNCTIONS
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * Batch-fetches segment objects from SDK by ID array.
   * Filters out any nulls (segments not loaded in current map view)
   * and logs a warning for each missing segment.
   *
   * @param {number[]} segmentIds - Array of segment IDs
   * @returns {Object[]} Array of non-null segment objects from SDK
   */
  function getSegmentsByIds(segmentIds) {
    return segmentIds
      .map((segmentId) => wmeSdk.DataModel.Segments.getById({ segmentId }))
      .filter((seg) => {
        if (seg == null) {
          logWarning('getSegmentsByIds: a segment was not found or not loaded in current map view');
        }
        return seg != null;
      });
  }

  /**
   * Get street by ID from SDK.
   * Returns null if streetId is falsy (0, null, undefined) without
   * making a redundant SDK call.
   *
   * @param {number} streetId - Street ID
   * @returns {Object|null} Street object or null
   */
  function getStreetById(streetId) {
    if (!streetId) return null;
    return wmeSdk.DataModel.Streets.getById({ streetId });
  }

  // ── Live Map Routing Helpers ────────────────────────────────────────────────

  /**
   * Get the correct Live Map routing API URL based on region code
   * @returns {string} Live Map routing API endpoint URL
   */
  function getLiveMapRouterUrl() {
    const regionCode = wmeSdk.Settings.getRegionCode();
    const regionStr = String(regionCode).toLowerCase();

    logDebug('getLiveMapRouterUrl: regionCode =', regionCode, 'lowercase =', regionStr);

    if (regionStr === 'il') {
      return 'https://routing-livemap-il.waze.com/RoutingManager/routingRequest';
    } else if (regionStr === 'usa') {
      return 'https://routing-livemap-am.waze.com/RoutingManager/routingRequest';
    } else {
      // REGION_CODE_ROW or unknown
      return 'https://routing-livemap-row.waze.com/RoutingManager/routingRequest';
    }
  }

  /**
   * Extract center coordinate from a segment using existing findMiddle() utility
   * @param {Object} segment - Segment object with geometry.coordinates
   * @returns {{ lon: number, lat: number } | null} Center coordinate or null if unavailable
   */
  function getSegmentCenter(segment) {
    const coords = segment?.geometry?.coordinates;
    const middle = findMiddle(coords);

    if (!middle) {
      logWarning(`getSegmentCenter: segment ${segment?.id} has no coordinates`);
      return null;
    }

    return {
      lon: middle[0],
      lat: middle[1],
    };
  }

  /**
   * Get turns from a segment using getTurnsFromSegment, handling multiple SDK response formats.
   * Replicates proven pattern from WME Routing Debugger.JS (line 109-119).
   * Returns array of turn objects or empty array on error/missing data.
   */
  function getTurnsFromSeg(segId) {
    try {
      const result = wmeSdk.DataModel.Turns.getTurnsFromSegment({ segmentId: segId });
      if (Array.isArray(result)) return result;
      if (result?.turns && Array.isArray(result.turns)) return result.turns;
      return [];
    } catch (e) {
      logDebug(`getTurnsFromSeg(${segId}) threw: ${e.message}`);
      return [];
    }
  }

  /**
   * Verifies if a turn from segA to segB at sharedNodeId is valid using getTurnsFromSegment.
   * Based on reference: WME SDK to Verify Routes Between Segments.md
   *
   * Returns: { valid: boolean, state: 'red'|'unverified'|'allowed'|'conditional', reason: string }
   */
  function verifyTurn(fromSegId, nodeId, toSegId) {
    try {
      // Get segment objects to determine which direction they exit/enter the node
      const fromSeg = wmeSdk.DataModel.Segments.getById({ segmentId: fromSegId });
      const toSeg = wmeSdk.DataModel.Segments.getById({ segmentId: toSegId });

      if (!fromSeg || !toSeg) {
        return {
          valid: false,
          state: 'error',
          reason: 'Segment not found',
        };
      }

      // Determine exit direction of fromSeg: true if exiting at toNode (A→B), false if at fromNode (B→A)
      const fromSegExitsAtTo = fromSeg.toNodeId === nodeId;
      const toSegEntersAtFrom = toSeg.fromNodeId === nodeId;

      logDebug(`verifyTurn: ${fromSegId}→${toSegId} at node ${nodeId}`);
      logDebug(`  fromSeg nodes: from=${fromSeg.fromNodeId} to=${fromSeg.toNodeId}`);
      logDebug(`  toSeg nodes: from=${toSeg.fromNodeId} to=${toSeg.toNodeId}`);
      logDebug(`  Looking for: fromSegFwd=${fromSegExitsAtTo}, toSegFwd=${toSegEntersAtFrom}`);

      // Get all turns from fromSegment (using proven wrapper pattern)
      const turns = getTurnsFromSeg(fromSegId);

      logDebug(`  Found ${turns.length} turns from segment ${fromSegId}`);
      if (turns.length === 0) {
        logDebug(`  WARNING: No turns returned. Turn data may not be loaded yet.`);
        // Return TURN_DATA_UNAVAILABLE status instead of hard failure (Phase 3)
        return {
          valid: false,
          state: 'TURN_DATA_UNAVAILABLE',
          reason: 'Turn data not available (SDK data may still be loading)',
        };
      }
      turns.forEach((t, i) => {
        if (t.toSegmentId === toSegId) {
          logDebug(`    Turn ${i}: to=${t.toSegmentId}, fromFwd=${t.fromSegmentFwd}, toFwd=${t.toSegmentFwd}, allowed=${t.isAllowed}`);
        }
      });

      // Find turn that matches BOTH segment IDs AND the correct direction through the node
      const turn = turns.find((t) => t.toSegmentId === toSegId && t.fromSegmentFwd === fromSegExitsAtTo && t.toSegmentFwd === toSegEntersAtFrom);

      if (!turn) {
        // turn object does not exist in this direction
        logDebug(`  No turn found matching direction!`);
        return {
          valid: false,
          state: 'red',
          reason: 'Turn is blocked (turn restriction prevents routing at this junction)',
        };
      }
      logDebug(`  Turn found! isAllowed=${turn.isAllowed}`);

      if (!turn.isAllowed && turn.restrictions.length === 0) {
        // turn exists but isAllowed=false with no restrictions
        return {
          valid: false,
          state: 'red',
          reason: 'Turn is blocked (turn restriction prevents routing at this junction)',
        };
      }

      if (turn.isAllowed && turn.restrictions.length > 0) {
        // Conditional — allowed with restrictions (time, vehicle, etc)
        return {
          valid: true,
          state: 'conditional',
          reason: `Turn allowed with ${turn.restrictions.length} restriction(s) (e.g., time-of-day, vehicle type)`,
          restrictions: turn.restrictions,
        };
      }

      // Green arrow — isAllowed=true with no restrictions
      return {
        valid: true,
        state: 'allowed',
        reason: 'Turn allowed',
      };
    } catch (err) {
      logDebug(`verifyTurn: SDK error for ${fromSegId}→${toSegId}: ${err.message}`);
      return {
        valid: false,
        state: 'error',
        reason: `Error checking turn: ${err.message}`,
      };
    }
  }

  /**
   * Direction-only check: can traffic physically exit fromSeg at nodeId?
   * Used by findDirectRoute to validate segment directionality.
   */
  function canExitSegment(segment, nodeId) {
    const exitsAtTo = segment.toNodeId === nodeId;
    const exitsAtFrom = segment.fromNodeId === nodeId;

    const canExit = (exitsAtTo && (segment.isAtoB || segment.isTwoWay)) || (exitsAtFrom && (segment.isBtoA || segment.isTwoWay));

    return canExit;
  }

  /**
   * Returns segments connected at a specific end of a segment.
   * end === 'from' → segments entering/leaving at the FROM node
   * end === 'to'   → segments entering/leaving at the TO node
   * Uses reverseDirection to target the correct physical end.
   */
  function getConnectedAtEnd(segment, end) {
    // end: 'from' = get segments connected at fromNodeId (A point)
    //      'to'   = get segments connected at toNodeId   (B point)

    const nodeId = end === 'from' ? segment.fromNodeId : segment.toNodeId;

    if (nodeId == null) {
      logDebug(`getConnectedAtEnd: segment ${segment.id} has no ${end}NodeId`);
      return [];
    }

    try {
      const node = wmeSdk.DataModel.Nodes.getById({ nodeId });
      if (!node) {
        logDebug(`getConnectedAtEnd: node ${nodeId} not found`);
        return [];
      }

      // Filter out the segment itself, return segment objects
      return node.connectedSegmentIds
        .filter((id) => id !== segment.id)
        .map((id) => wmeSdk.DataModel.Segments.getById({ segmentId: id }))
        .filter((s) => s != null);
    } catch (err) {
      logError(`getConnectedAtEnd error:`, err);
      return [];
    }
  }

  /**
   * Validates that [seg0, seg1, ..., segN] is a fully drivable path.
   * Uses getTurnsFromSegment to check actual turn state (red/unverified/green/conditional).
   *
   * For each consecutive pair:
   *   1. Finds shared node
   *   2. Checks if traffic can exit segA at that node (direction check)
   *   3. Verifies turn using getTurnsFromSegment (turn state check)
   */
  function validatePath(segments) {
    for (let i = 0; i < segments.length - 1; i++) {
      const segA = segments[i];
      const segB = segments[i + 1];

      // Step 1: Find shared node
      const sharedNodeId = getConnectingNode(segA, segB);
      if (sharedNodeId == null) {
        return {
          valid: false,
          failIndex: i,
          reason: `Segments ${segA.id} and ${segB.id} do not share a node`,
          state: 'not_connected',
        };
      }

      // Step 2: Check direction — can segA exit toward the shared node?
      if (!canExitSegment(segA, sharedNodeId)) {
        return {
          valid: false,
          failIndex: i,
          reason: `Segment ${segA.id} is one-way and flows away from node ${sharedNodeId}`,
          state: 'direction_blocked',
        };
      }

      // Step 3: Check turn using getTurnsFromSegment
      const turnResult = verifyTurn(segA.id, sharedNodeId, segB.id);
      if (!turnResult.valid) {
        return {
          valid: false,
          failIndex: i,
          reason: `Segments ${segA.id} to ${segB.id}: ${turnResult.reason}`,
          state: turnResult.state,
        };
      }
    }
    return { valid: true, failIndex: null, reason: null };
  }

  /**
   * Get the other node from a segment (SDK replacement for segment.getOtherNode())
   * Given a segment and one of its nodes, returns the other node
   * @param {Object} segment - Segment object with fromNodeId and toNodeId
   * @param {Object} knownNode - Node object with id property
   * @returns {Object|null} The other node object or null if not found
   */
  function getOtherNode(segment, knownNode) {
    //logDebug('getOtherNode called');
    try {
      if (!segment || !knownNode) return null;
      if (segment.fromNodeId === knownNode.id) {
        return wmeSdk.DataModel.Nodes.getById({ nodeId: segment.toNodeId });
      } else if (segment.toNodeId === knownNode.id) {
        return wmeSdk.DataModel.Nodes.getById({ nodeId: segment.fromNodeId });
      }
      logDebug('getOtherNode returning null');
      return null;
    } catch (err) {
      logError('getOtherNode error:', err);
      return null;
    }
  }

  // Helper: Find shared node between two segments (JAI pattern from ja_get_connecting_node)
  function getConnectingNode(segA, segB) {
    if (!segA || !segB) return null;
    if (segA.fromNodeId === segB.fromNodeId || segA.fromNodeId === segB.toNodeId) return segA.fromNodeId;
    if (segA.toNodeId === segB.fromNodeId || segA.toNodeId === segB.toNodeId) return segA.toNodeId;
    return null;
  }

  // Helper: Given entry node, determine exit node for traversal, respecting one-way direction
  function getExitNode(segment, entryNodeId) {
    const isAtoB = segment.isAtoB;
    const isBtoA = segment.isBtoA;
    const isTwoWay = isAtoB && isBtoA;

    if (isTwoWay) {
      // Two-way: can enter at either node, exit is the other
      if (entryNodeId === segment.fromNodeId) return segment.toNodeId;
      if (entryNodeId === segment.toNodeId) return segment.fromNodeId;
      return null;
    }

    if (isAtoB) {
      // One-way A→B: must enter at fromNode, exits at toNode
      if (entryNodeId === segment.fromNodeId) return segment.toNodeId;
      return null; // wrong way
    }

    if (isBtoA) {
      // One-way B→A: must enter at toNode, exits at fromNode
      if (entryNodeId === segment.toNodeId) return segment.fromNodeId;
      return null; // wrong way
    }

    // Neither isAtoB nor isBtoA — not drivable (railroad, etc.)
    return null;
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // doZOOM FUNCTION
  // ═════════════════════════════════════════════════════════════════════════════════════
  /**
   * Zoom and pan to a specific location
   * Migrated to use wmeSdk.Map APIs
   *
   * @param {boolean} restore - If true, restore previous zoom/center; otherwise show alert
   * @param {number} zoom - Zoom level to set
   * @param {Object} coordObj - Coordinates { lon, lat } to center on
   */
  async function doZoom(restore = false, zoom = -1, coordObj = {}) {
    if (zoom === -1 || Object.entries(coordObj).length === 0) {
      return Promise.resolve();
    }

    try {
      // Get current zoom level using SDK (replaces W.map.getZoom)
      const currentZoom = wmeSdk.Map.getZoomLevel();

      wmeSdk.Map.setMapCenter({
        lonLat: {
          lon: coordObj.lon,
          lat: coordObj.lat,
        },
        zoomLevel: zoom,
      });

      logDebug(`doZoom: Set map center to [${coordObj.lon}, ${coordObj.lat}] at zoom ${zoom}`);

      if (restore) {
        logDebug(`doZoom: Restore mode - no event wait needed`);
        _restoreZoomLevel = null;
        _restoreMapCenter = undefined;
      } else {
        // Wait for map data to load at new zoom/center, with 2-second timeout to prevent hanging
        logDebug(`doZoom: Waiting for map data with 2s timeout...`);
        await Promise.race([
          new Promise((resolve) => {
            const handleMapDataLoaded = () => {
              wmeSdk.Events.off({
                eventName: 'wme-map-data-loaded',
                eventHandler: handleMapDataLoaded,
              });
              logDebug(`doZoom: Map data loaded event received`);
              resolve();
            };

            wmeSdk.Events.on({
              eventName: 'wme-map-data-loaded',
              eventHandler: handleMapDataLoaded,
            });
          }),
          new Promise((resolve) => {
            setTimeout(() => {
              logDebug(`doZoom: Timeout after 2s - proceeding anyway`);
              resolve();
            }, 2000);
          }),
        ]);
      }
    } catch (err) {
      logError('doZoom error:', err);
    }

    return Promise.resolve();
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // RTG and Name Continuity FUNCTIONS
  // ═════════════════════════════════════════════════════════════════════════════════════

  function rtgContinuityCheck([...segs] = []) {
    if (segs.length < 2) return false;

    const rtg = { 7: 'mH', 6: 'MHFW', 3: 'MHFW' };
    const seg1rtg = rtg[segs[0].roadType];

    // If the first segment has no defined RTG group, can't check continuity
    if (seg1rtg === undefined) return false;

    // Compare all remaining segments against the first segment's RTG
    // Uses slice(1) instead of splice(0,1) — no mutation needed
    return segs.slice(1).every((el) => {
      const currentRTG = rtg[el.roadType];
      if (currentRTG === undefined) return false;
      return seg1rtg === currentRTG;
    });
  }

  function nameContinuityCheck([...segs] = []) {
    if (segs.length < 2) return false;

    // Helper: collect all non-empty street names from a segment
    function getSegStreetNames(seg) {
      const names = [];
      if (seg.primaryStreetId) {
        const street = getStreetById(seg.primaryStreetId);
        if (street?.name?.length > 0) names.push(street.name);
      }
      if (seg.alternateStreetIds?.length > 0) {
        for (const streetId of seg.alternateStreetIds) {
          const street = getStreetById(streetId);
          if (street?.name?.length > 0) names.push(street.name);
        }
      }
      return names;
    }

    if (segs.length === 2) {
      // ── TWO-SEGMENT MODE ──────────────────────────────────────────────────────
      // Used for: bracketing segment pair check (must share a name)
      const seg0Names = getSegStreetNames(segs[0]);
      if (seg0Names.length === 0) return false;

      const seg1Names = getSegStreetNames(segs[1]);
      // True if any name in seg1 appears in seg0's name list
      return seg1Names.some((name) => seg0Names.includes(name));
    } else {
      // ── MULTI-SEGMENT MODE ────────────────────────────────────────────────────
      // Used for: full route continuity check
      // Rule: every middle segment must share a name with EITHER
      //       the first segment OR the last segment

      const firstSeg = segs[0];
      const lastSeg = segs[segs.length - 1];
      const middleSegs = segs.slice(1, -1); // everything between first and last

      const bs1Names = getSegStreetNames(firstSeg);
      const bs2Names = getSegStreetNames(lastSeg);

      if (bs1Names.length === 0) return false;
      if (bs2Names.length === 0) return false;

      return middleSegs.every((el) => {
        const elNames = getSegStreetNames(el);
        return elNames.some((name) => bs1Names.includes(name) || bs2Names.includes(name));
      });
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // LIVE MAP ROUTING FUNCTION
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * Fetch routes from Live Map API and validate them
   * Uses GM_xmlhttpRequest to query Waze Live Map routing endpoint
   * @param {Object} startSeg - Starting bracketing segment
   * @param {Object} endSeg - Ending bracketing segment
   * @param {number} maxLength - Maximum route length in meters
   * @returns {Promise<number[][]>} Array of valid routes (each route is array of segment IDs)
   */
  async function findLiveMapRoutes(startSeg, endSeg, maxLength) {
    const startCenter = getSegmentCenter(startSeg);
    const endCenter = getSegmentCenter(endSeg);

    if (!startCenter || !endCenter) {
      logWarning('findLiveMapRoutes: Could not extract coordinates from segments');
      return [];
    }

    const url = getLiveMapRouterUrl();

    // ─────────────────────────────────────────────────────────────────────────────
    // Live Map API Request Parameters Documentation
    // ─────────────────────────────────────────────────────────────────────────────
    //
    // PARAMETERS WE ARE SETTING (and why):
    // ────────────────────────────────────
    //
    // 1. from / to (REQUIRED)
    //    - Format: "x:longitude y:latitude bd:true"
    //    - bd:true = "by distance" flag to snap coordinates to nearest road segment
    //    - We use segment centerpoints (via getSegmentCenter) for accurate positioning
    //
    // 2. returnJSON: true
    //    - Response format as JSON (vs XML)
    //    - Easier to parse than XML in JavaScript
    //
    // 3. returnGeometries: false
    //    - OBSERVED: API ignores this flag and always returns full coordinate arrays
    //    - Setting to false reduces request size (best practice for network efficiency)
    //    - Response still includes "coords" array regardless (server behavior)
    //
    // 4. returnInstructions: false
    //    - OBSERVED: API ignores this flag and always returns turn instruction objects
    //    - Setting to false reduces request size (best practice for network efficiency)
    //    - Response still includes "instruction" in each path segment regardless
    //    - Note: Instructions are already in path.instruction, so the flag may be legacy
    //
    // 5. timeout: 60000 (60 seconds)
    //    - Server-side timeout for route calculation
    //    - Wrapped with Promise.race() for client-side 15s timeout as safety layer
    //
    // 6. type: 'HISTORIC_TIME'
    //    - Routing model: use historical traffic patterns (not real-time)
    //    - Ensures consistent results for BDP validation (independent of current congestion)
    //
    // 7. nPaths: 3
    //    - Return up to 3 alternative routes
    //    - Provides routing diversity without excessive API load
    //
    // 8. clientVersion: '4.0.0'
    //    - API version identifier
    //    - Ensures server compatibility and consistent response format
    //
    // 9. options: "AVOID_TOLL_ROADS:f,AVOID_PRIMARIES:f,AVOID_TRAILS:f,ALLOW_UTURNS:t"
    //    Individual routing constraints:
    //    - AVOID_TOLL_ROADS:f   = Allow toll roads (f = false = don't avoid)
    //    - AVOID_PRIMARIES:f    = Allow freeways/highways (don't avoid primary roads)
    //    - AVOID_TRAILS:f       = Allow unpaved/dirt roads (don't avoid trails)
    //    - ALLOW_UTURNS:t       = Permit U-turns at waypoints (t = true = allow)
    //    Strategy: Maximize routing flexibility to find ANY possible BDP route.
    //    We don't restrict route options because BDP checking needs all variants.
    //
    // ────────────────────────────────────────────────────────────────────────────
    // PARAMETERS WE ARE NOT SETTING (and why):
    // ────────────────────────────────────────
    //
    // 1. vehicleType
    //    - Options: PRIVATE (default), TAXI, MOTORCYCLE
    //    - Not set: Assumes PRIVATE vehicles (standard BDP checking context)
    //    - If TAXI/MOTORCYCLE restrictions matter, add as configurable parameter
    //
    // 2. id
    //    - Added dynamically only for beta.waze.com (see code below)
    //    - Not needed for production Waze Editor routing
    //
    // 3. routePreferences / avoidAreas / requiredPermits
    //    - Advanced parameters for specialized routing scenarios
    //    - Not applicable for standard BDP validation checking
    //
    // 4. lang / units
    //    - Localization/units in response (defaults to server preferences)
    //    - Not needed since we only extract segment IDs, not user-facing text
    //
    // ────────────────────────────────────────────────────────────────────────────

    const data = {
      from: `x:${startCenter.lon} y:${startCenter.lat} bd:true`,
      to: `x:${endCenter.lon} y:${endCenter.lat} bd:true`,
      returnJSON: true,
      returnGeometries: false,
      returnInstructions: false,
      timeout: 60000,
      type: 'HISTORIC_TIME',
      nPaths: 3,
      clientVersion: '4.0.0',
      options: 'AVOID_TOLL_ROADS:f,AVOID_PRIMARIES:f,AVOID_TRAILS:f,ALLOW_UTURNS:t',
    };

    // Add beta ID if on beta Waze
    if (window.location.hostname === 'beta.waze.com') {
      data.id = 'beta';
    }

    const returnRoutes = [];

    return new Promise((resolve) => {
      // Build query string manually to match jQuery.param() encoding
      const queryParams = Object.keys(data)
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
        .join('&');
      const fullUrl = url + '?' + queryParams;
      logDebug('findLiveMapRoutes: Full API URL:', fullUrl);
      logDebug('findLiveMapRoutes: Request data:', data);
      logDebug('findLiveMapRoutes: URL base:', url);

      GM_xmlhttpRequest({
        method: 'GET',
        url: fullUrl,
        headers: {
          'Content-Type': 'application/json',
        },
        onload: (response) => {
          logDebug('findLiveMapRoutes: Raw response:', response.responseText);
          logDebug('findLiveMapRoutes: Response status:', response.status);
          try {
            const jsonData = JSON.parse(response.responseText);
            logDebug('findLiveMapRoutes: API response received', jsonData);

            if (jsonData.error || !jsonData.response) {
              logWarning('findLiveMapRoutes: API error or empty response', jsonData);
              resolve([]);
              return;
            }

            const routesToProcess = jsonData.alternatives ? jsonData.alternatives : [jsonData];
            log(`findLiveMapRoutes: Processing ${routesToProcess.length} alternative route(s)`);

            for (const route of routesToProcess) {
              try {
                const routeSegments = route.response?.results;
                if (!Array.isArray(routeSegments)) {
                  logDebug('findLiveMapRoutes: route has no results array');
                  continue;
                }

                const fullRouteSegIds = routeSegments.map((segment) => segment.path?.segmentId).filter((id) => id != null);

                if (fullRouteSegIds.length === 0) {
                  logDebug('findLiveMapRoutes: route has no segment IDs');
                  continue;
                }

                logDebug(`findLiveMapRoutes: Route segment IDs: [${fullRouteSegIds.join(',')}]`);

                const fullRouteSegs = getSegmentsByIds(fullRouteSegIds);
                if (nameContinuityCheck(fullRouteSegs) && rtgContinuityCheck(fullRouteSegs)) {
                  logDebug('findLiveMapRoutes: Name and RTG continuity checks passed');

                  const routeDistance = fullRouteSegs
                    .slice(1, -1)
                    .map((seg) => seg.length)
                    .reduce((a, b) => a + b, 0);

                  if (routeDistance < maxLength) {
                    logDebug(`findLiveMapRoutes: Route within maxLength (${routeDistance}m < ${maxLength}m)`);
                    returnRoutes.push(fullRouteSegIds);
                  } else {
                    logDebug(`findLiveMapRoutes: Route exceeds maxLength (${routeDistance}m >= ${maxLength}m)`);
                  }
                } else {
                  logDebug('findLiveMapRoutes: Continuity check failed');
                }
              } catch (err) {
                logWarning('findLiveMapRoutes: Error processing route:', err);
              }
            }

            resolve(returnRoutes);
          } catch (err) {
            logError('findLiveMapRoutes: JSON parse error:', err);
            resolve([]);
          }
        },
        onerror: (error) => {
          logWarning('findLiveMapRoutes: Network error:', error);
          resolve([]);
        },
        ontimeout: () => {
          logWarning('findLiveMapRoutes: Request timeout');
          resolve([]);
        },
      });
    });
  }

  /**
   * Wrapper around findLiveMapRoutes with 15-second timeout
   * @param {Object} startSeg - Starting bracketing segment
   * @param {Object} endSeg - Ending bracketing segment
   * @param {number} maxLength - Maximum route length in meters
   * @returns {Promise<number[][]>} Array of valid routes or empty array on timeout
   */
  async function findLiveMapRoutesWithTimeout(startSeg, endSeg, maxLength) {
    try {
      return await Promise.race([findLiveMapRoutes(startSeg, endSeg, maxLength), new Promise((_, reject) => setTimeout(() => reject(new Error('Live Map routing timeout (15s)')), 15000))]);
    } catch (err) {
      logWarning('findLiveMapRoutesWithTimeout: Timeout or error:', err);
      return [];
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // FIND DIRECT ROUTE FUNCTION
  // ═════════════════════════════════════════════════════════════════════════════════════
  /**
   * Finds first valid continuous route between startSeg and endSeg.
   * Uses simple recursion to explore segment paths, then validates complete
   * paths using validatePath() which checks direction, turns, continuity, and length.
   * Returns on first valid route found (not all routes).
   *
   * @param {Object} obj
   * @param {number}   obj.maxLength  - Maximum total route length in meters
   * @param {Object}   obj.startSeg   - Starting bracketing segment object
   * @param {Object}   obj.startNode  - Node object where we EXIT startSeg
   * @param {Object}   obj.endSeg     - Ending bracketing segment object
   * @param {number[]} obj.endNodeIds - Valid arrival node IDs on endSeg
   * @returns {number[][]} Array of routes, each route is an array of segment IDs
   */
  function findDirectRoute(obj = {}) {
    const { maxLength, startSeg, startNode, endSeg, endNodeIds } = obj;

    const foundRouteKeys = new Set();
    const returnRoutes = [];

    // ── Which end of startSeg are we exiting from? ────────────────────────────
    const startExitEnd = startNode.id === startSeg.toNodeId ? 'to' : 'from';

    // ── Get initial candidates from startSeg's exit end ───────────────────────
    const initialCandidates = getConnectedAtEnd(startSeg, startExitEnd).filter((seg) => seg.id !== startSeg.id);

    logDebug(`findDirectRoute: startSeg=${startSeg.id} exitEnd=${startExitEnd} ` + `startNode=${startNode.id} candidates=[${initialCandidates.map((s) => s.id).join(',')}]`);

    // ── Log startSeg direction details for debugging ───────────────────────────
    logDebug(
      `startSeg ${startSeg.id} details: ` +
        `fromNodeId=${startSeg.fromNodeId} toNodeId=${startSeg.toNodeId} ` +
        `isAtoB=${startSeg.isAtoB} isBtoA=${startSeg.isBtoA} ` +
        `isTwoWay=${startSeg.isAtoB && startSeg.isBtoA}`,
    );

    // ── Process each initial candidate ────────────────────────────────────────
    for (const sOut of initialCandidates) {
      // Name + RTG continuity first (cheap check)
      if (!nameContinuityCheck([startSeg, sOut]) || !rtgContinuityCheck([startSeg, sOut])) {
        logDebug(`findDirectRoute: continuity fail startSeg→${sOut.id}`);
        continue;
      }

      // Check direction: can sOut be entered at startNode and what's its exit?
      // getExitNode returns the exit node if entry is valid, null if invalid
      const sOutExitNodeId = getExitNode(sOut, startNode.id);
      if (sOutExitNodeId == null) {
        logDebug(`findDirectRoute: sOut ${sOut.id} cannot enter at ${startNode.id} (direction mismatch)`);
        continue;
      }

      // ── DFS stack ─────────────────────────────────────────────────────────
      // Each frame: { seg, entryNodeId, exitNodeId, pathSoFar, lengthSoFar }
      const stack = [
        {
          seg: sOut,
          entryNodeId: startNode.id,
          exitNodeId: sOutExitNodeId,
          pathSoFar: [sOut.id],
          lengthSoFar: sOut.length,
        },
      ];

      const MAX_ITERATIONS = 100000;
      let iterationCount = 0;

      while (stack.length > 0 && iterationCount < MAX_ITERATIONS && returnRoutes.length === 0) {
        iterationCount++;

        const frame = stack[stack.length - 1];
        const { seg: curSeg, exitNodeId: curExitNodeId, pathSoFar, lengthSoFar } = frame;

        // ── Reached endSeg? ───────────────────────────────────────────────
        if (curSeg.id === endSeg.id) {
          if (endNodeIds.includes(curExitNodeId)) {
            const fullRoute = [startSeg.id, ...pathSoFar];
            const routeKey = fullRoute.join(',');
            if (!foundRouteKeys.has(routeKey)) {
              foundRouteKeys.add(routeKey);
              returnRoutes.push(fullRoute);
              logDebug(`findDirectRoute: found route [${routeKey}]`);
              break;
            }
          }
          stack.pop();
          continue;
        }

        // ── Can we reach endSeg directly from here? ───────────────────────
        const sharedWithEnd = getConnectingNode(curSeg, endSeg);
        if (sharedWithEnd != null && sharedWithEnd === curExitNodeId) {
          // Check direction: can endSeg be entered at the shared node?
          const endExitNodeId = getExitNode(endSeg, sharedWithEnd);
          if (endExitNodeId != null && endNodeIds.includes(endExitNodeId)) {
            const fullRoute = [startSeg.id, ...pathSoFar, endSeg.id];
            const routeKey = fullRoute.join(',');
            if (!foundRouteKeys.has(routeKey)) {
              foundRouteKeys.add(routeKey);
              returnRoutes.push(fullRoute);
              logDebug(`findDirectRoute: found route via direct hop [${routeKey}]`);
              break;
            }
          }
          stack.pop();
          continue;
        }

        // ── Length limit ──────────────────────────────────────────────────
        if (lengthSoFar > maxLength) {
          logDebug(`findDirectRoute: length ${lengthSoFar} > max ${maxLength}, backtrack`);
          stack.pop();
          continue;
        }

        // ── Expand neighbors ──────────────────────────────────────────────
        const curExitEnd = curExitNodeId === curSeg.toNodeId ? 'to' : 'from';

        const neighbors = getConnectedAtEnd(curSeg, curExitEnd).filter((neighbor) => !pathSoFar.includes(neighbor.id) && neighbor.id !== startSeg.id);

        // Push ALL valid neighbors so DFS can backtrack and try each one
        let pushedAny = false;
        for (const nextSeg of neighbors) {
          // Check direction: can nextSeg be entered at the exit node and what's its exit?
          const nextExitNodeId = getExitNode(nextSeg, curExitNodeId);
          if (nextExitNodeId == null) {
            logDebug(`findDirectRoute: ${nextSeg.id} cannot enter at ${curExitNodeId} (direction mismatch)`);
            continue;
          }

          if (!nameContinuityCheck([curSeg, nextSeg]) || !rtgContinuityCheck([curSeg, nextSeg])) {
            logDebug(`findDirectRoute: continuity fail ${curSeg.id}→${nextSeg.id}`);
            continue;
          }

          const linkedToStart = nameContinuityCheck([startSeg, nextSeg]) && rtgContinuityCheck([startSeg, nextSeg]);
          const linkedToEnd = nameContinuityCheck([endSeg, nextSeg]) && rtgContinuityCheck([endSeg, nextSeg]);
          if (!linkedToStart && !linkedToEnd) {
            logDebug(`findDirectRoute: not linked to brackets: ${nextSeg.id}`);
            continue;
          }

          stack.push({
            seg: nextSeg,
            entryNodeId: curExitNodeId,
            exitNodeId: nextExitNodeId,
            pathSoFar: [...pathSoFar, nextSeg.id],
            lengthSoFar: lengthSoFar + nextSeg.length,
          });
          pushedAny = true;
          // No break — push all valid neighbors for full DFS exploration
        }

        if (!pushedAny) {
          logDebug(`findDirectRoute: dead end at ${curSeg.id}, backtracking`);
          stack.pop();
        }
      }

      if (iterationCount >= MAX_ITERATIONS) {
        logWarning(`findDirectRoute: MAX_ITERATIONS (${MAX_ITERATIONS}) reached — route search aborted`);
      }

      if (returnRoutes.length > 0) break;
    }

    logDebug(`findDirectRoute: returning ${returnRoutes.length} route(s)`);
    return returnRoutes;
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // DO BDP CHECK FUNCTION
  // ═════════════════════════════════════════════════════════════════════════════════════
  /**
   * Main BDP check function
   * Migrated to wmeSdk.Editing API for selection
   * Keeps WazeWrap.Alerts for user feedback
   * @param {boolean} useLiveMap - If true, use Live Map routing; if false, use SDK routing
   */
  async function doCheckBDP(useLiveMap = false) {
    logDebug('doCheckBDP called with useLiveMap:', useLiveMap);

    try {
      // ── Declare all shared variables at top ────────────────────────────────
      let reportContainer;
      let startSeg, endSeg, endSegFarNodeId;
      let lastDetourSeg = null;
      let endNodeObj = null;
      let directRoutes = [];

      // MODE 1 flags
      let nameContCheckPassed = false;
      let rtgContCheckPassed = false;

      // MODE 2 flags
      let nameDiscontinuityPassed = false;
      let rtgDiscontinuityPassed = false;
      let segmentCountPassed = false;
      let unrouteableTypesPassed = false;
      let unrouteableFound = [];
      let lengthCheckPassed = false;
      let detourLength = 0;
      let maxDetourLength = 0;
      let turnValidityPassed = true; // true until a failure is found
      let turnFailureReason = '';

      // Shared node arrays (used in both Mode 1 and Mode 2)
      const startNodeObjs = [];
      const endNodeObjs = [];

      // ── Clear previous report ──────────────────────────────────────────────
      reportContainer = getReportContainer();
      if (reportContainer) reportContainer.innerHTML = '';

      // ── Get selection ──────────────────────────────────────────────────────
      const selection = wmeSdk.Editing.getSelection();
      logDebug('Selection received:', selection);

      if (!selection || selection.objectType !== 'segment' || !selection.ids || selection.ids.length < 2) {
        WazeWrap.Alerts.error(_SCRIPT_SHORT_NAME, 'You must select either the two <i>bracketing segments</i> or an entire ' + 'detour route with <i>bracketing segments</i>.');
        return;
      }

      // ── Get segment objects ────────────────────────────────────────────────
      const selectedSegs = getSegmentsByIds(selection.ids);
      logDebug(`Got ${selectedSegs.length} segments`);

      // ── Validate count ─────────────────────────────────────────────────────
      if (selectedSegs.length === 3) {
        WazeWrap.Alerts.error(
          _SCRIPT_SHORT_NAME,
          'You selected 3 segments. A detour route must have at least 2 intermediate ' + 'segments (4+ total). Please select either 2 bracketing segments OR 4+ segments.',
        );
        return;
      }

      // ── Validate connectivity for 2-segment mode ───────────────────────────
      if (selectedSegs.length === 2) {
        const sharedNode = getConnectingNode(selectedSegs[0], selectedSegs[1]);
        if (sharedNode != null) {
          WazeWrap.Alerts.error(_SCRIPT_SHORT_NAME, 'You selected only two segments and they connect to each other. ' + 'There are no alternate routes.');
          return;
        }
      }

      // ── Determine start/end segments and far node ──────────────────────────
      if (selectedSegs.length === 2) {
        logDebug('BDP called with Two segments selected.');
        [startSeg, endSeg] = selectedSegs;
        logDebug(`Segment relationship: seg1=${startSeg.id} ` + `nodes=[${startSeg.fromNodeId},${startSeg.toNodeId}], ` + `seg2=${endSeg.id} nodes=[${endSeg.fromNodeId},${endSeg.toNodeId}]`);
        // Mode 1: no far node needed
        endSegFarNodeId = null;
      } else {
        // Mode 2: determine orientation
        if (_pathEndSegId && selectedSegs[0].id === _pathEndSegId) {
          endSeg = selectedSegs[0];
          startSeg = selectedSegs[selectedSegs.length - 1];
        } else {
          startSeg = selectedSegs[0];
          endSeg = selectedSegs[selectedSegs.length - 1];
        }

        // Far node = the node of endSeg NOT connected to the rest of the path
        const penultimateSeg = selectedSegs[selectedSegs.length - 2];
        const connectingNodeId = getConnectingNode(penultimateSeg, endSeg);
        endSegFarNodeId = connectingNodeId === endSeg.fromNodeId ? endSeg.toNodeId : endSeg.fromNodeId;

        logDebug(`Mode 2: startSeg=${startSeg.id} endSeg=${endSeg.id} ` + `connectingNode=${connectingNodeId} farNode=${endSegFarNodeId}`);
      }

      // ── Road type validation ───────────────────────────────────────────────
      const invalidRoadType = (seg) => seg.roadType < 3 || seg.roadType === 4 || seg.roadType === 5 || seg.roadType > 7;

      if (invalidRoadType(startSeg) || invalidRoadType(endSeg)) {
        WazeWrap.Alerts.warning(_SCRIPT_SHORT_NAME, 'At least one bracketing segment is not the correct road type for BDP.', 0, 0);
        return;
      }

      // ── RTG continuity (bracketing segments must match) ────────────────────
      rtgContCheckPassed = rtgContinuityCheck([startSeg, endSeg]);
      if (!rtgContCheckPassed) {
        logDebug('rtgContinuityCheck failed');
        WazeWrap.Alerts.warning(
          _SCRIPT_SHORT_NAME,
          'One bracketing segment is a minor highway while the other is not. ' + 'BDP only applies when bracketing segments are in the same road type group.',
        );
        return;
      }

      // ── Name continuity (bracketing segments must match) ───────────────────
      nameContCheckPassed = nameContinuityCheck([startSeg, endSeg]);
      if (!nameContCheckPassed) {
        logDebug('nameContinuityCheck failed');
        return;
      }

      // ── Max search length ──────────────────────────────────────────────────
      const maxLength = startSeg.roadType === 7 ? 5000 : 50000;
      logDebug(`maxLength assigned: ${maxLength}`);

      // ── Build node arrays (shared between Mode 1 and Mode 2) ───────────────
      // startNodeObjs: exit nodes of startSeg (where we leave it)
      if (startSeg.isAtoB) {
        const n = wmeSdk.DataModel.Nodes.getById({ nodeId: startSeg.toNodeId });
        if (n) startNodeObjs.push(n);
      }
      if (startSeg.isBtoA) {
        const n = wmeSdk.DataModel.Nodes.getById({ nodeId: startSeg.fromNodeId });
        if (n) startNodeObjs.push(n);
      }

      // endNodeObjs: exit nodes of endSeg (valid arrival nodes)
      if (endSeg.isAtoB) {
        const n = wmeSdk.DataModel.Nodes.getById({ nodeId: endSeg.toNodeId });
        if (n) endNodeObjs.push(n);
      }
      if (endSeg.isBtoA) {
        const n = wmeSdk.DataModel.Nodes.getById({ nodeId: endSeg.fromNodeId });
        if (n) endNodeObjs.push(n);
      }

      logDebug(`startNodeObjs ids: [${startNodeObjs.map((n) => n.id).join(', ')}]`);
      logDebug(`endNodeObjs ids:   [${endNodeObjs.map((n) => n.id).join(', ')}]`);

      // ══════════════════════════════════════════════════════════════════════
      // MODE 1: Two bracketing segments only
      // ══════════════════════════════════════════════════════════════════════
      if (selectedSegs.length === 2) {
        logDebug('MODE 1: Two segments selected - searching for direct route between bracketing segments');

        // Zoom to level 16 for route-finding visibility and turn data availability
        const currentZoom = wmeSdk.Map.getZoomLevel();
        if (currentZoom !== 16) {
          _restoreZoomLevel = currentZoom;
          _restoreMapCenter = wmeSdk.Map.getMapCenter();
          await doZoom(false, 16, getMidpoint(startSeg, endSeg));
        }

        if (useLiveMap) {
          logDebug('MODE 1: Searching for routes via Live Map API');
          try {
            directRoutes = await findLiveMapRoutesWithTimeout(startSeg, endSeg, maxLength);
            if (directRoutes.length > 0) {
              logDebug('Live Map Routes found:', directRoutes);
              logDebug('# of Live Map routes:', directRoutes.length);
              // Validate turn state on each route found (turn data now available at zoom ≥ 16)
              directRoutes.forEach((route, idx) => {
                const routeSegs = getSegmentsByIds(route);
                const validation = validatePath(routeSegs);
                logDebug(`Route ${idx + 1} turn validation:`, validation);
              });
            } else {
              logDebug('MODE 1: Live Map API returned no valid routes');
            }
          } catch (err) {
            logWarning(`MODE 1: Live Map routing failed:`, err);
            // Fallback to SDK routing
            logDebug('MODE 1: Falling back to SDK routing');
            for (let i = 0; i < startNodeObjs.length; i++) {
              const startNode = startNodeObjs[i];
              directRoutes = findDirectRoute({
                maxLength,
                startSeg,
                startNode,
                endSeg,
                endNodeIds: endNodeObjs.map((n) => n.id),
              });
              if (directRoutes.length > 0) break;
            }
          }
        } else {
          logDebug('MODE 1: Searching for routes via SDK routing');
          // Try each start exit node
          for (let i = 0; i < startNodeObjs.length; i++) {
            const startNode = startNodeObjs[i];
            logDebug(`findDirectRoute call ${i + 1}: ` + `startNode=${startNode.id}, ` + `endNodeIds=[${endNodeObjs.map((n) => n.id).join(', ')}]`);
            directRoutes = findDirectRoute({
              maxLength,
              startSeg,
              startNode,
              endSeg,
              endNodeIds: endNodeObjs.map((n) => n.id),
            });
            logDebug(`findDirectRoute returned ${directRoutes.length} routes`);
            if (directRoutes.length > 0) {
              logDebug('Qualifying Direct Routes:', directRoutes);
              logDebug('# of qualifying direct routes:', directRoutes.length);
              // Validate turn state on each route found (turn data now available at zoom ≥ 16)
              // Note: SDK returns segment IDs, need to convert to objects for validatePath
              directRoutes.forEach((route, idx) => {
                const routeSegs = getSegmentsByIds(route);
                const validation = validatePath(routeSegs);
                logDebug(`Route ${idx + 1} turn validation:`, validation);
              });
              break;
            }
          }
        }

        // ══════════════════════════════════════════════════════════════════════
        // MODE 2: Full detour route selected (4+ segments)
        // ══════════════════════════════════════════════════════════════════════
      } else {
        logDebug('MODE 2: Multi-segment selection (4+) - validating detour and searching for direct route');

        // ── Build route segment IDs (excluding bracketing segs) ────────────
        const routeSegIds = selectedSegs.map((seg) => seg.id).filter((id) => id !== endSeg.id && id !== startSeg.id);

        // ── Find endNodeObj: node of endSeg that connects to the detour ────
        // endSegFarNodeId was set in the start/end determination block above
        const farNode = wmeSdk.DataModel.Nodes.getById({ nodeId: endSegFarNodeId });
        if (!farNode) {
          logError(`MODE 2: farNode ${endSegFarNodeId} not found`);
          return;
        }
        endNodeObj = getOtherNode(endSeg, farNode); // assigns to hoisted variable
        if (!endNodeObj) {
          logError('MODE 2: endNodeObj not found — getOtherNode returned null');
          return;
        }
        logDebug(`MODE 2: endNodeObj=${endNodeObj.id} farNode=${farNode.id}`);

        // ── Find lastDetourSeg: detour segment connecting to endSeg ────────
        const connectedToEnd = endNodeObj.connectedSegmentIds ?? [];
        const lastDetourSegIds = routeSegIds.filter((id) => connectedToEnd.includes(id));

        if (lastDetourSegIds.length === 1) {
          lastDetourSeg = getSegmentsByIds([lastDetourSegIds[0]])[0]; // hoisted
        } else if (lastDetourSegIds.length > 1) {
          // Multiple candidates — disambiguate via one-way turn direction
          const oneWayTest = getSegmentsByIds(lastDetourSegIds).filter((seg) => {
            const isTwoWay = seg.isAtoB && seg.isBtoA;
            if (isTwoWay) return false;
            // Check if segment can be entered or exited at endNodeObj
            return canExitSegment(endSeg, endNodeObj.id) || canExitSegment(seg, endNodeObj.id);
          });
          if (oneWayTest.length === 1) {
            [lastDetourSeg] = oneWayTest; // hoisted
          } else {
            return;
          }
        } else {
          logError('MODE 2: No detour segments connect to endNodeObj');
          return;
        }
        logDebug(`MODE 2: lastDetourSeg=${lastDetourSeg.id}`);

        // ── Detour segment analysis ────────────────────────────────────────
        const detourSegs = selectedSegs.slice(1, -1);
        const detourSegTypes = [...new Set(detourSegs.map((seg) => seg.roadType))];
        logDebug('MODE 2: Detour segments:', detourSegs);
        logDebug(`MODE 2: Detour road types: ${detourSegTypes}`);

        // ── Zoom if needed (skip for freeway-type detours) ─────────────────
        if (![1].some((t) => detourSegTypes.includes(t))) {
          const currentZoom = wmeSdk.Map.getZoomLevel();
          // Zoom to level 16 for route-finding visibility and turn data availability
          if (currentZoom !== 16) {
            _restoreZoomLevel = currentZoom;
            _restoreMapCenter = wmeSdk.Map.getMapCenter();
            await doZoom(false, 16, getMidpoint(startSeg, endSeg));
          }
        }

        logDebug('MODE 2: ⏳ Starting validation checks...');

        // ── Validation: NAME DISCONTINUITY ────────────────────────────────
        // Detour must NOT share name with bracketing (proves true detour)
        nameDiscontinuityPassed = !nameContinuityCheck([lastDetourSeg, endSeg]); // hoisted flag
        logDebug(nameDiscontinuityPassed ? 'MODE 2: OK - detour name differs from bracketing' : 'MODE 2: FAIL - detour shares name with bracketing segment');

        // ── Validation: RTG DISCONTINUITY ─────────────────────────────────
        // Detour must NOT share RTG with bracketing
        rtgDiscontinuityPassed = !rtgContinuityCheck([lastDetourSeg, endSeg]); // hoisted flag
        logDebug(rtgDiscontinuityPassed ? 'MODE 2: OK - detour RTG differs from bracketing' : 'MODE 2: FAIL - detour shares RTG with bracketing segment');

        // ── Validation: SEGMENT COUNT ──────────────────────────────────────
        segmentCountPassed = detourSegs.length >= 2; // hoisted flag
        logDebug(segmentCountPassed ? `MODE 2: OK - ${detourSegs.length} intermediate segments` : 'MODE 2: FAIL - less than 2 intermediate segments');

        // ── Validation: VALID ROAD TYPES (non-fatal) ──────────────────────
        const unrouteableTypes = [9, 10, 16, 18, 19, 22];
        unrouteableFound = unrouteableTypes.filter((t) => detourSegTypes.includes(t)); // hoisted flag
        unrouteableTypesPassed = unrouteableFound.length === 0; // hoisted flag
        if (!unrouteableTypesPassed) {
          WazeWrap.Alerts.warning(_SCRIPT_SHORT_NAME, 'Your selection contains one or more segments with an unrouteable road type. ' + 'The selected route is not a valid route.');
          // Non-fatal: continue to report card for full detail
        }
        logDebug(`MODE 2: VALID ROAD TYPES: ${unrouteableTypesPassed ? 'OK' : 'FAIL'}`);

        // ── Validation: ROUTE LENGTH ───────────────────────────────────────
        detourLength = detourSegs.map((s) => s.length).reduce((a, b) => a + b, 0); // hoisted flag
        maxDetourLength = startSeg.roadType === 7 ? 500 : 5000; // hoisted flag
        lengthCheckPassed = detourLength <= maxDetourLength; // hoisted flag
        logDebug(lengthCheckPassed ? `MODE 2: OK - detour ${detourLength}m within ${maxDetourLength}m limit` : `MODE 2: FAIL - detour ${detourLength}m exceeds max ${maxDetourLength}m`);

        // ── Validation: TURN VALIDITY ──────────────────────────────────────
        // Check turns between consecutive detour segments using full turn validation
        logDebug(`MODE 2: ⏳ Checking turn validity for ${detourSegs.length} detour segments...`);
        for (let i = 0; i < detourSegs.length - 1 && turnValidityPassed; i++) {
          const curSeg = detourSegs[i];
          const nextSeg = detourSegs[i + 1];
          const connectingNodeId = getConnectingNode(curSeg, nextSeg);
          logDebug(`MODE 2: Turn check ${i + 1}/${detourSegs.length - 1}: Seg ${curSeg.id} → ${nextSeg.id}`);

          if (connectingNodeId == null) {
            turnValidityPassed = false;
            turnFailureReason = `Detour segments ${i + 1} and ${i + 2} do not share a node`;
          } else {
            // Use verifyTurn for full validation (checks turn state via getTurnsFromSegment)
            const turnResult = verifyTurn(curSeg.id, connectingNodeId, nextSeg.id);
            logDebug(`MODE 2: Turn ${i + 1} result: ${turnResult.state}`);
            if (!turnResult.valid) {
              turnValidityPassed = false;
              turnFailureReason = `${turnResult.reason} between detour segment ${i + 1} and ${i + 2}`;
            }
          }
        }
        logDebug(`MODE 2: Turn validity check complete: ${turnValidityPassed ? 'PASS' : 'FAIL'}`);

        // Check final turn: lastDetourSeg → endSeg
        if (turnValidityPassed) {
          const finalNodeId = getConnectingNode(lastDetourSeg, endSeg);
          if (finalNodeId == null) {
            turnValidityPassed = false;
            turnFailureReason = 'Last detour segment does not connect to end bracketing segment';
          } else {
            // Use verifyTurn for full validation (checks turn state via getTurnsFromSegment)
            const turnResult = verifyTurn(lastDetourSeg.id, finalNodeId, endSeg.id);
            if (!turnResult.valid) {
              turnValidityPassed = false;
              turnFailureReason = `${turnResult.reason} from last detour segment to bracketing segment`;
            }
          }
        }
        logDebug(`MODE 2: TURN VALIDITY: ${turnValidityPassed ? 'OK' : `FAIL - ${turnFailureReason}`}`);

        // ── Find direct route ──────────────────────────────────────────────
        // startNodeObjs and endNodeObjs already built in shared section above
        if (useLiveMap) {
          logDebug('MODE 2: ⏳ Searching for direct route via Live Map API...');
          try {
            directRoutes = await findLiveMapRoutesWithTimeout(startSeg, endSeg, maxLength);
            if (directRoutes.length > 0) {
              logDebug(`MODE 2: Direct route found via Live Map: ${directRoutes.length} route(s)`);
              // Validate turn state on each route found (turn data now available at zoom ≥ 16)
              // Note: Live Map returns segment IDs, need to convert to objects for validatePath
              directRoutes = directRoutes.map((route) => {
                const routeSegs = getSegmentsByIds(route);
                const validation = validatePath(routeSegs);
                logDebug(`Route turn validation:`, validation);
                return route; // Keep original IDs for final result
              });
            } else {
              logDebug('MODE 2: Live Map API returned no valid routes');
            }
          } catch (err) {
            logWarning(`MODE 2: Live Map routing failed:`, err);
            // Fallback to SDK routing
            logDebug('MODE 2: Falling back to SDK routing');
            for (let i = 0; i < startNodeObjs.length; i++) {
              const startNode = startNodeObjs[i];
              directRoutes = findDirectRoute({
                maxLength,
                startSeg,
                startNode,
                endSeg,
                endNodeIds: endNodeObjs.map((n) => n.id),
              });
              if (directRoutes.length > 0) {
                // Validate routes from fallback SDK call
                directRoutes.forEach((route, idx) => {
                  const routeSegs = getSegmentsByIds(route);
                  const validation = validatePath(routeSegs);
                  logDebug(`Route ${idx + 1} turn validation (fallback):`, validation);
                });
                break;
              }
            }
          }
        } else {
          logDebug('MODE 2: ⏳ Searching for direct route via SDK routing...');
          for (let i = 0; i < startNodeObjs.length; i++) {
            logDebug(`MODE 2: Direct route search attempt ${i + 1}...`);
            const startNode = startNodeObjs[i];
            logDebug(`findDirectRoute call ${i + 1}: ` + `startNode=${startNode.id} ` + `endNodeIds=[${endNodeObjs.map((n) => n.id).join(', ')}]`);
            directRoutes = findDirectRoute({
              maxLength,
              startSeg,
              startNode,
              endSeg,
              endNodeIds: endNodeObjs.map((n) => n.id),
            });
            if (directRoutes.length > 0) {
              logDebug(`MODE 2: Direct route found: ${directRoutes.length} route(s)`);
              // Validate turn state on each route found (turn data now available at zoom ≥ 16)
              directRoutes.forEach((route, idx) => {
                const routeSegs = getSegmentsByIds(route);
                const validation = validatePath(routeSegs);
                logDebug(`Route ${idx + 1} turn validation:`, validation);
              });
              break;
            }
          }
        }
      } // end of Mode 2 execution block

      logDebug('MODE 2: 🎉 Completed - about to restore zoom and build report');

      // ── Restore zoom ───────────────────────────────────────────────────────
      if (directRoutes.length > 0) {
        logDebug('Direct Route | A Direct Route has been found');
      } else if (selectedSegs.length === 2) {
        logDebug('Direct Route | **NO** Direct Routes found between the two selected segments!');
      } else {
        logDebug('Direct Route | **NO** Direct Routes found between segments!');
      }

      logDebug('⏳ Restoring zoom...');
      await doZoom(true, _restoreZoomLevel, _restoreMapCenter);
      logDebug('✅ Zoom restored');

      // ══════════════════════════════════════════════════════════════════════
      // REPORT CARD
      // ══════════════════════════════════════════════════════════════════════
      logDebug('⏳ Building report card...');

      const testResults = [];
      let routingMode = '';
      let allTestsPassed = false;
      const directRouteFound = directRoutes.length > 0;

      if (selectedSegs.length === 2) {
        // ── MODE 1 ────────────────────────────────────────────────────────
        routingMode = 'MODE_1';

        // Read hoisted flags — no recalculation
        testResults.push({
          name: 'NAME CONTINUITY',
          passed: nameContCheckPassed,
          explanation: nameContCheckPassed ? 'Bracketing segments share street names' : 'Bracketing segments do not share a street name',
        });
        testResults.push({
          name: 'RTG CONTINUITY',
          passed: rtgContCheckPassed,
          explanation: rtgContCheckPassed ? 'Bracketing segments are in the same road type group' : 'Bracketing segments are in different road type groups',
        });

        // Turn validity and length are implicitly proven by findDirectRoute:
        // if a route was found, all turns were valid and length was within limits
        testResults.push({
          name: 'TURN VALIDITY',
          passed: directRouteFound,
          explanation: directRouteFound ? 'All segment junctions allow valid turns' : 'No valid route found — turn restriction or invalid direction',
        });
        testResults.push({
          name: 'ROUTE LENGTH',
          passed: directRouteFound,
          explanation: directRouteFound ? 'Direct route found within length limits' : 'No valid route found within length limits',
        });

        allTestsPassed = nameContCheckPassed && rtgContCheckPassed && directRouteFound;
      } else {
        // ── MODE 2 ────────────────────────────────────────────────────────
        routingMode = 'MODE_2';

        // Safety guard — execution section should have returned early if these
        // are null, but guard here in case of silent failure
        if (!lastDetourSeg || !endNodeObj) {
          logError('MODE 2 report: lastDetourSeg or endNodeObj is null — execution section failed silently');
          return;
        }

        const detourSegs = selectedSegs.slice(1, -1);

        // Read hoisted flags — no recalculation
        testResults.push({
          name: 'NAME DISCONTINUITY',
          passed: nameDiscontinuityPassed,
          explanation: nameDiscontinuityPassed ? 'Detour segment name differs from final bracketing segment' : 'Detour segment shares name with final bracketing segment',
        });
        testResults.push({
          name: 'RTG DISCONTINUITY',
          passed: rtgDiscontinuityPassed,
          explanation: rtgDiscontinuityPassed ? 'Detour RTG differs from final bracketing segment' : 'Detour RTG matches final bracketing segment',
        });
        testResults.push({
          name: 'SEGMENT COUNT',
          passed: segmentCountPassed,
          explanation: `Detour has ${detourSegs.length} segment${detourSegs.length === 1 ? '' : 's'} ` + `(minimum 2 required)`,
        });
        testResults.push({
          name: 'VALID ROAD TYPES',
          passed: unrouteableTypesPassed,
          explanation: unrouteableTypesPassed ? 'All detour segments have routeable road types' : `Detour contains unrouteable road types: ${unrouteableFound.join(', ')}`,
        });
        testResults.push({
          name: 'ROUTE LENGTH',
          passed: lengthCheckPassed,
          explanation: `Detour ${detourLength.toFixed(0)}m, max ${maxDetourLength}m`,
        });
        testResults.push({
          name: 'TURN VALIDITY',
          passed: turnValidityPassed,
          explanation: turnValidityPassed ? 'All segment junctions allow valid turns' : turnFailureReason,
        });

        // Check if detour segments are identical to the direct route
        const detourSegIds = detourSegs.map((s) => s.id);
        const detourIsDirectRoute = directRouteFound && directRoutes[0] && detourSegIds.join(',') === directRoutes[0].join(',');
        testResults.push({
          name: 'IS DIRECT ROUTE',
          passed: !detourIsDirectRoute,
          explanation: detourIsDirectRoute ? 'Selection is the direct route — users would take this, not a detour' : 'Detour is an alternate path, not the direct route',
        });

        allTestsPassed = nameDiscontinuityPassed && rtgDiscontinuityPassed && segmentCountPassed && unrouteableTypesPassed && lengthCheckPassed && turnValidityPassed && !detourIsDirectRoute;
      }

      // ── Verdict ────────────────────────────────────────────────────────────
      const verdict = allTestsPassed && directRouteFound ? 'BDP_WILL_APPLY' : 'BDP_WONT_APPLY';
      const verdictMessage = getVerdictMessage(verdict, routingMode);

      // ── Build checkResults ─────────────────────────────────────────────────
      const checkResults = {
        mode: routingMode,
        verdict: verdict,
        verdictMessage: verdictMessage,
        testResults: testResults,
        directRoute: directRouteFound
          ? {
              segmentIds: directRoutes[0] ?? [],
              length: getSegmentsByIds(directRoutes[0])
                .map((s) => s.length)
                .reduce((a, b) => a + b, 0),
              streetNames: [
                ...new Set(
                  getSegmentsByIds(directRoutes[0]).flatMap((seg) => {
                    const names = [];
                    if (seg.primaryStreetId) {
                      const street = wmeSdk.DataModel.Streets.getById({
                        streetId: seg.primaryStreetId,
                      });
                      if (street?.name) names.push(street.name);
                    }
                    (seg.alternateStreetIds ?? []).forEach((streetId) => {
                      const street = wmeSdk.DataModel.Streets.getById({
                        streetId,
                      });
                      if (street?.name) names.push(street.name);
                    });
                    return names;
                  }),
                ),
              ],
            }
          : null,
      };

      logDebug('checkResults:', checkResults);

      // ── Render report ──────────────────────────────────────────────────────
      const report = buildBDPReport(checkResults);
      const reportHTML = renderReportCardHTML(report);
      reportContainer = getReportContainer();
      if (reportContainer) {
        reportContainer.innerHTML = reportHTML;
        logDebug('Report displayed in BDP tab');
      } else {
        logWarning('Could not get report container to display report');
      }
    } catch (err) {
      logError('doCheckBDP error:', err);
      WazeWrap.Alerts.error(_SCRIPT_SHORT_NAME, `An error occurred: ${err.message}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // BOOTSTRAP INITIALIZATION
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * Setup event listeners using SDK Events API
   * Pattern from WME-JAI.js testSelectedItem() and WME-SU.js line 1752
   */
  function setupEventListeners() {
    // Listen for selection changes and update button state
    wmeSdk.Events.on({
      eventName: 'wme-selection-changed',
      eventHandler: updateBDPCheckButtonState,
    });

    logDebug('Event listeners setup complete');
  }

  /**
   * Create and register the BDP Check sidebar tab
   * Pattern from WME-SU.js - cleaner than panel injection
   */
  async function createBDPCheckTab() {
    try {
      // Register a new tab in the Scripts section
      const { tabLabel, tabPane } = await wmeSdk.Sidebar.registerScriptTab();

      tabLabel.textContent = 'BDP';
      tabLabel.title = _SCRIPT_LONG_NAME;
      tabPane.className = 'wme-bdc-pane';

      // ── CSS (scoped to .wme-bdc-pane) ───────────────────────────────────
      const styleEl = document.createElement('style');
      styleEl.textContent = [
        '.wme-bdc-pane { padding: 8px; box-sizing: border-box; overflow-x: hidden; }',
        '.wme-bdc-pane .bdc-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 8px 10px; background: linear-gradient(135deg, #0066cc, #0052a3); color: #fff; border-radius: 8px; }',
        '.wme-bdc-pane .bdc-header-left { display: flex; align-items: center; gap: 6px; }',
        '.wme-bdc-pane .bdc-header-icon { color: #fff; font-size: 1.2em; }',
        '.wme-bdc-pane .bdc-header-name { font-weight: 700; font-size: 13px; color: #fff; }',
        '.wme-bdc-pane .bdc-header-version { font-size: 10px; opacity: 0.8; color: #fff; }',
        '.wme-bdc-pane .bdc-card { border: 1px solid var(--hairline, #ddd); border-radius: 8px; margin-bottom: 8px; overflow: hidden; }',
        '.wme-bdc-pane .bdc-card-header { display: flex; align-items: center; gap: 7px; padding: 7px 10px; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid var(--hairline, #ddd); background: linear-gradient(135deg, #f8f9fa, #f0f1f3); color: #333; }',
        '.wme-bdc-pane .bdc-card-header:hover { background: linear-gradient(135deg, #f0f1f3, #e8eaed); }',
        '.wme-bdc-pane .bdc-card-header i { color: #0066cc; font-size: 1px; width: 14px; text-align: center; }',
        '.wme-bdc-pane .bdc-card-body { padding: 2px 0; }',
        '.wme-bdc-pane .bdc-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 10px; min-height: 32px; box-sizing: border-box; }',
        '.wme-bdc-pane .bdc-info-text { font-size: 11px; color: #666; line-height: 1.4; padding: 0 10px 8px 10px; }',
        '.wme-bdc-pane .bdc-button-group { margin-bottom: 8px; }',
        '.wme-bdc-pane .bdc-button-group wz-button { width: 100%; padding: 4px 4px;}',
        '.wme-bdc-pane .bdc-info-heading { display: block; margin-bottom: 6px; font-weight: 600; }',
        '.wme-bdc-pane .bdc-info-modes { margin-bottom: 8px; font-size: 10px; line-height: 1.5; }',
        '.wme-bdc-pane .bdc-test-result { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 11px; line-height: 1.3; }',
        '.wme-bdc-pane .bdc-test-icon { min-width: 14px; flex-shrink: 0; font-size: 12px; margin-top: 1px; }',
        '.wme-bdc-pane .bdc-test-name { font-weight: 600; color: var(--content_default, #333); min-width: 80px; flex-shrink: 0; }',
        '.wme-bdc-pane .bdc-test-explanation { color: #666; font-size: 11px; flex: 1; }',
        '.wme-bdc-pane .bdc-verdict-box { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--background_default, #fff); border-left: 4px solid #0066cc; }',
        '.wme-bdc-pane .bdc-verdict-emoji { font-size: 20px; flex-shrink: 0; }',
        '.wme-bdc-pane .bdc-verdict-text { flex: 1; color: var(--content_default, #333); font-weight: 600; }',
        '.wme-bdc-pane .bdc-verdict-yes { border-left-color: #28a745; background: #f0fef7; }',
        '.wme-bdc-pane .bdc-verdict-no { border-left-color: #dc3545; background: #fef5f5; }',
        '.wme-bdc-pane .bdc-verdict-inconclusive { border-left-color: #ffc107; background: #fffbf0; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-header { background: linear-gradient(135deg, #0052a3, #003d7a); }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-card-header { background: linear-gradient(135deg, #2a2c30, #202124); color: #e8eaed; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-card-header:hover { background: linear-gradient(135deg, #333538, #2a2c30); }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-card-header i { color: #33ccff; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-verdict-box { background: #1a1a1a; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-info-text { color: #a0a0a0; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-test-explanation { color: #a0a0a0; }',
        '.wme-bdc-pane .bdc-rules-content { padding: 10px; font-size: 11px; line-height: 1.6; color: #666; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-content { color: #a0a0a0; }',
        '.wme-bdc-pane .bdc-rules-purpose { margin-bottom: 10px; padding: 8px; background: var(--background_neutral, #f8f9fa); border-radius: 4px; border-left: 3px solid #0066cc; }',
        '.wme-bdc-pane .bdc-rules-purpose strong { color: #333; display: block; font-size: 12px; }',
        '.wme-bdc-pane .bdc-rules-purpose span { font-size: 10px; color: #666; display: block; margin-top: 4px; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-purpose { background: #2a2c30; border-left-color: #33ccff; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-purpose strong { color: #e8eaed; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-purpose span { color: #a0a0a0; }',
        '.wme-bdc-pane .bdc-rules-section { margin-bottom: 12px; }',
        '.wme-bdc-pane .bdc-rules-section h3 { color: #333; display: block; margin-bottom: 6px; font-size: 12px; margin: 0 0 6px 0; }',
        '.wme-bdc-pane .bdc-rules-section div { margin-left: 4px; font-size: 10px; line-height: 1.6; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-section h3 { color: #e8eaed; }',
        '.wme-bdc-pane .bdc-rules-divider { margin-bottom: 12px; padding: 10px 0; border-top: 1px solid var(--hairline, #f0f0f0); }',
        '.wme-bdc-pane .bdc-rules-divider h3 { color: #333; display: block; margin-bottom: 6px; font-size: 12px; margin: 0 0 6px 0; }',
        '.wme-bdc-pane .bdc-rules-divider div { margin-left: 4px; font-size: 10px; line-height: 1.6; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-divider h3 { color: #e8eaed; }',
        '.wme-bdc-pane .bdc-rules-label { color: #0066cc; font-weight: bold; }',
        '.wme-bdc-pane .bdc-rules-yes { color: #28a745; font-weight: bold; font-size: 11px; }',
        '.wme-bdc-pane .bdc-rules-no { color: #dc3545; font-weight: bold; font-size: 11px; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-label { color: #33ccff; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-yes { color: #5dd865; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-no { color: #ff6b6b; }',
        '.wme-bdc-pane .bdc-rules-footer { padding-top: 8px; border-top: 1px solid var(--hairline, #f0f0f0); margin-top: 8px; text-align: center; }',
        '.wme-bdc-pane .bdc-rules-footer a { color: #0066cc; text-decoration: none; font-weight: 600; font-size: 11px; }',
        '[wz-theme="dark"] .wme-bdc-pane .bdc-rules-footer a { color: #33ccff; }',
      ].join('\n');
      tabPane.appendChild(styleEl);

      // ── Header: Script name + version ───────────────────────────────────
      const header = document.createElement('div');
      header.className = 'bdc-header';
      const headerLeft = document.createElement('div');
      headerLeft.className = 'bdc-header-left';
      const headerIcon = document.createElement('i');
      headerIcon.className = 'fa fa-road bdc-header-icon';
      const headerName = document.createElement('span');
      headerName.className = 'bdc-header-name';
      headerName.textContent = _SCRIPT_LONG_NAME;
      headerLeft.appendChild(headerIcon);
      headerLeft.appendChild(headerName);
      const headerVersion = document.createElement('span');
      headerVersion.className = 'bdc-header-version';
      headerVersion.textContent = `v${_SCRIPT_VERSION}`;
      header.appendChild(headerLeft);
      header.appendChild(headerVersion);
      tabPane.appendChild(header);

      // ── Info Card ───────────────────────────────────────────────────────
      const infoCard = document.createElement('div');
      infoCard.className = 'bdc-card';
      const infoCardHeader = document.createElement('div');
      infoCardHeader.className = 'bdc-card-header';
      infoCardHeader.innerHTML = '<i class="fa fa-info-circle"></i><span>How to Use</span>';
      infoCard.appendChild(infoCardHeader);
      const infoCardBody = document.createElement('div');
      infoCardBody.className = 'bdc-card-body';
      const infoText = document.createElement('div');
      infoText.className = 'bdc-info-text';
      infoText.innerHTML = `
        <strong class="bdc-info-heading">Select segments to check:</strong>
        <div class="bdc-info-modes">
          <strong>MODE 1 (2 segments):</strong> Direct path check between two segments!<br>
          <strong>MODE 2 (4+ segments):</strong> Detour validity check!
        </div>
      `;
      infoCardBody.appendChild(infoText);
      infoCard.appendChild(infoCardBody);
      tabPane.appendChild(infoCard);

      // ── Actions Card ────────────────────────────────────────────────────
      const actionsCard = document.createElement('div');
      actionsCard.className = 'bdc-card';
      const actionsCardHeader = document.createElement('div');
      actionsCardHeader.className = 'bdc-card-header';
      actionsCardHeader.innerHTML = '<i class="fa fa-cogs"></i><span>Actions</span>';
      actionsCard.appendChild(actionsCardHeader);
      const actionsCardBody = document.createElement('div');
      actionsCardBody.className = 'bdc-card-body';

      // Buttons container
      const buttonsDiv = document.createElement('div');
      buttonsDiv.className = 'bdc-button-group';
      buttonsDiv.style.padding = '10px';

      // WME check button
      _bdpCheckButton = createElem(
        'wz-button',
        {
          id: 'WME-BDPC-WME-TAB',
          color: 'primary',
          size: 'sm',
          disabled: true,
          textContent: 'Check BDP (WME)',
          title: 'Check BDP using WME routing',
        },
        [
          {
            click: async (evt) => {
              evt.preventDefault();
              await doCheckBDP(false);
            },
          },
        ],
      );
      buttonsDiv.appendChild(_bdpCheckButton);

      // Live Map check button
      _bdpCheckViaLMButton = createElem(
        'wz-button',
        {
          id: 'WME-BDPC-LM-TAB',
          color: 'primary',
          size: 'sm',
          disabled: true,
          textContent: 'Check BDP (Live Map)',
          title: 'Check BDP using Live Map routing',
        },
        [
          {
            click: async (evt) => {
              evt.preventDefault();
              await doCheckBDP(true);
            },
          },
        ],
      );
      buttonsDiv.appendChild(_bdpCheckViaLMButton);

      actionsCardBody.appendChild(buttonsDiv);
      actionsCard.appendChild(actionsCardBody);
      tabPane.appendChild(actionsCard);

      // ── Report container (where check results will be displayed) ───────
      const reportContainer = createElem('div', {
        id: 'bdc-report-container',
        className: 'bdc-report-container',
      });
      tabPane.appendChild(reportContainer);

      // ── BDP Rules Card ──────────────────────────────────────────────────
      const rulesCard = document.createElement('div');
      rulesCard.className = 'bdc-card';
      const rulesCardHeader = document.createElement('div');
      rulesCardHeader.className = 'bdc-card-header';
      rulesCardHeader.style.cursor = 'pointer';
      rulesCardHeader.innerHTML = '<i class="fa fa-book"></i><span>BDP Rules</span><i class="fa fa-chevron-down" style="margin-left: auto; font-size: 9px;"></i>';
      rulesCard.appendChild(rulesCardHeader);
      const rulesCardBody = document.createElement('div');
      rulesCardBody.className = 'bdc-card-body';
      rulesCardBody.innerHTML = `
        <div class="bdc-rules-content">
          <div class="bdc-rules-purpose">
            <strong>🎯 BDP Purpose</strong>
            <span>Prevents Waze from suggesting users detour off a highway and quickly rejoin unless it saves significant time.</span>
          </div>

          <div class="bdc-rules-section">
            <h3>✅ When BDP Applies</h3>
            <div>
              BDP applies when <strong>EITHER</strong>:<br>
              <br>
              <span class="bdc-rules-label">1. Direct Path Exists (Mode 1)</span><br>
              A continuous route with matching street names & road types links the bracketing highway segments<br>
              <br>
              <span class="bdc-rules-label">2. Detour Is Invalid (Mode 2)</span><br>
              The selected detour has different street name <strong>OR</strong> road type than the highway end segment
            </div>
          </div>

          <div class="bdc-rules-divider">
            <h3>📍 Mode 1: Check for Direct Route (2 segments)</h3>
            <div>
              <strong>Setup:</strong> Select start highway segment → end highway segment<br>
              <strong>Check:</strong> Does a valid continuous path connect them?<br>
              <br>
              • Same street names throughout<br>
              • Same road type group throughout<br>
              • All turns allowed at junctions<br>
              • Total length ≤ 5km (freeway) or 50km (minor highway)<br>
              <br>
              <span class="bdc-rules-yes">✅ If YES:</span> <span class="bdc-rules-yes">Direct route exists → BDP applies</span><br>
              <span class="bdc-rules-no">❌ If NO:</span> <span class="bdc-rules-no">No valid direct route found</span>
            </div>
          </div>

          <div class="bdc-rules-divider">
            <h3>🛣️ Mode 2: Check Detour (4+ segments)</h3>
            <div>
              <strong>Setup:</strong> Select start highway → detour route → end highway<br>
              <strong>Check:</strong> Is the detour genuinely different from the highway?<br>
              <br>
              • Detour <strong>MUST</strong> have different street name than end highway, <strong>OR</strong><br>
              • Detour <strong>MUST</strong> have different road type than end highway<br>
              • Final turn from detour to highway is allowed<br>
              • Length ≤ 5km (freeway) or 50km (minor highway)<br>
              <br>
              <span class="bdc-rules-yes">✅ If DIFFERENT:</span> <span class="bdc-rules-yes">Real detour found → BDP applies</span><br>
              <span class="bdc-rules-no">❌ If SAME:</span> <span class="bdc-rules-no">Not a real detour → No BDP</span>
            </div>
          </div>

          <div class="bdc-rules-footer">
            <a href="https://www.waze.com/discuss/t/detour-prevention-mechanisms/377917" target="_blank">
              📖 Full Official Documentation
            </a>
          </div>
        </div>
      `;
      rulesCard.appendChild(rulesCardBody);
      tabPane.appendChild(rulesCard);

      // Collapsible behavior for rules card — collapsed by default
      rulesCardBody.style.display = 'none';
      const chevron = rulesCardHeader.querySelector('.fa-chevron-down');
      if (chevron) {
        chevron.style.transform = 'rotate(-180deg)';
        chevron.style.transition = 'transform 0.2s';
      }
      rulesCardHeader.addEventListener('click', () => {
        const isHidden = rulesCardBody.style.display === 'none';
        rulesCardBody.style.display = isHidden ? '' : 'none';
        const chevron = rulesCardHeader.querySelector('.fa-chevron-down');
        if (chevron) {
          chevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-180deg)';
          chevron.style.transition = 'transform 0.2s';
        }
      });

      logDebug('BDP Check sidebar tab created successfully');
      return true;
    } catch (err) {
      logError('Failed to create sidebar tab:', err);
      return false;
    }
  }

  /**
   * Update button enabled/disabled state based on selection
   */
  function updateBDPCheckButtonState() {
    const selection = wmeSdk.Editing.getSelection();
    const hasSegments = selection && selection.objectType === 'segment' && selection.ids && selection.ids.length >= 2;

    if (_bdpCheckButton) {
      _bdpCheckButton.disabled = !hasSegments;
      // For web components, also update the disabled attribute
      if (!hasSegments) {
        _bdpCheckButton.setAttribute('disabled', '');
      } else {
        _bdpCheckButton.removeAttribute('disabled');
      }
    }

    if (_bdpCheckViaLMButton) {
      _bdpCheckViaLMButton.disabled = !hasSegments;
      // For web components, also update the disabled attribute
      if (!hasSegments) {
        _bdpCheckViaLMButton.setAttribute('disabled', '');
      } else {
        _bdpCheckViaLMButton.removeAttribute('disabled');
      }
    }

    logDebug(`BDP buttons: ${hasSegments ? 'enabled' : 'disabled'}`);
  }

  /**
   * Main initialization via Bootstrap.js
   * Pattern from WME-SU.js lines 1842-1849
   */
  async function initScript() {
    try {
      // Initialize SDK via Bootstrap.js (same as WME-SU.js)
      wmeSdk = await bootstrap({
        scriptId: _SETTINGS_STORE_NAME, // Unique script ID
        useWazeWrap: true, // Load WazeWrap alongside SDK
        //scriptUpdateMonitor: { downloadUrl: _DOWNLOAD_URL },
      });

      logDebug('Bootstrap initialization complete. wmeSdk ready.');

      // Load settings from localStorage
      await loadSettingsFromStorage();

      // Setup event listeners
      setupEventListeners();

      // Create BDP Check sidebar tab
      await createBDPCheckTab();

      // Initialize button state for current selection
      updateBDPCheckButtonState();

      // Show info if needed
      showScriptInfoAlert();

      log(`Fully initialized in ${Math.round(performance.now() - _LOAD_BEGIN_TIME)} ms.`);
    } catch (err) {
      logError('Failed to initialize script:', err);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // ENTRY POINT: START ASYNC INITIALIZATION
  // ═════════════════════════════════════════════════════════════════════════════════════

  initScript().catch((err) => logError('initScript failed:', err));
})();
