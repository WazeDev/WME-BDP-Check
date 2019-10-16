/* eslint-disable no-nested-ternary */
// ==UserScript==
// @name        WME BDP Check (beta)
// @namespace   https://greasyfork.org/users/166843
// @version     2019.10.16.01
// @description Check for possible BDP routes between two selected segments.
// @author      dBsooner
// @include     /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @require     https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @grant       none
// @license     GPLv3
// ==/UserScript==

/* global localStorage, window, $, performance, GM_info, W, WazeWrap */

const ALERT_UPDATE = true,
    DEBUG = true,
    LOAD_BEGIN_TIME = performance.now(),
    // SCRIPT_AUTHOR = GM_info.script.author,
    SCRIPT_FORUM_URL = '',
    SCRIPT_GF_URL = '',
    SCRIPT_NAME = GM_info.script.name.replace('(beta)', 'β'),
    SCRIPT_VERSION = GM_info.script.version,
    SCRIPT_VERSION_CHANGES = ['<b>CHANGE:</b> Initial release.'],
    SETTINGS_STORE_NAME = 'WMEBDPC',
    _timeouts = { bootstrap: undefined, saveSettingsToStorage: undefined };
let _settings = {};

function log(message) { console.log('WME-BDPC:', message); }
function logError(message) { console.error('WME-BDPC:', message); }
function logWarning(message) { console.warn('WME-BDPC:', message); }
function logDebug(message) {
    if (DEBUG)
        console.log('WME-BDPC:', message);
}

function loadSettingsFromStorage() {
    return new Promise(async resolve => {
        const defaultSettings = {
                lastSaved: 0,
                lastVersion: undefined
            },
            loadedSettings = $.parseJSON(localStorage.getItem(SETTINGS_STORE_NAME));
        _settings = $.extend({}, defaultSettings, loadedSettings);
        const serverSettings = await WazeWrap.Remote.RetrieveSettings(SETTINGS_STORE_NAME);
        if (serverSettings && (serverSettings.lastSaved > _settings.lastSaved))
            $.extend(_settings, serverSettings);
        _timeouts.saveSettingsToStorage = window.setTimeout(saveSettingsToStorage, 5000);
        resolve();
    });
}

function saveSettingsToStorage() {
    checkTimeout({ timeout: 'saveSettingsToStorage' });
    if (localStorage) {
        _settings.lastVersion = SCRIPT_VERSION;
        _settings.lastSaved = Date.now();
        localStorage.setItem(SETTINGS_STORE_NAME, JSON.stringify(_settings));
        WazeWrap.Remote.SaveSettings(SETTINGS_STORE_NAME, _settings);
        logDebug('Settings saved.');
    }
}

function showScriptInfoAlert() {
    if (ALERT_UPDATE && SCRIPT_VERSION !== _settings.lastVersion) {
        let releaseNotes = '';
        releaseNotes += '<p>What\'s new:</p>';
        if (SCRIPT_VERSION_CHANGES.length > 0) {
            releaseNotes += '<ul>';
            for (let idx = 0; idx < SCRIPT_VERSION_CHANGES.length; idx++)
                releaseNotes += `<li>${SCRIPT_VERSION_CHANGES[idx]}`;
            releaseNotes += '</ul>';
        }
        else {
            releaseNotes += '<ul><li>Nothing major.</ul>';
        }
        WazeWrap.Interface.ShowScriptUpdate(SCRIPT_NAME, SCRIPT_VERSION, releaseNotes, SCRIPT_GF_URL, SCRIPT_FORUM_URL);
    }
}

function checkTimeout(obj) {
    if (obj.toIndex) {
        if (_timeouts[obj.timeout] && (_timeouts[obj.timeout][obj.toIndex] !== undefined)) {
            window.clearTimeout(_timeouts[obj.timeout][obj.toIndex]);
            _timeouts[obj.timeout][obj.toIndex] = undefined;
        }
    }
    else {
        if (_timeouts[obj.timeout] !== undefined)
            window.clearTimeout(_timeouts[obj.timeout]);
        _timeouts[obj.timeout] = undefined;
    }
}

function findObjIndex(array, fldName, value) {
    return array.map(a => a[fldName]).indexOf(value);
}

function rtgContinuityCheck(segs = []) {
    if (segs.length < 2)
        return false;
    const rtg = { 7: 'mH', 6: 'MHFW', 3: 'MHFW' },
        seg1rtg = rtg[segs[0].attributes.roadType];
    segs.splice(0, 1);
    return segs.every(el => seg1rtg === rtg[el.attributes.roadType]);
}

function nameContinuityCheck(segs = []) {
    if (segs.length < 2)
        return false;
    const streetNames = [];
    let street;
    if (segs[0].attributes.primaryStreetID) {
        street = W.model.streets.getObjectById(segs[0].attributes.primaryStreetID);
        if (street && street.name && (street.name.length > 0))
            streetNames.push(street.name);
    }
    if (segs[0].attributes.streetIDs.length > 0) {
        for (let i = 0; i < segs[0].attributes.streetIDs.length; i++) {
            street = W.model.streets.getObjectById(segs[0].attributes.streetIDs[i]);
            if (street && street.name && (street.name.length > 0))
                streetNames.push(street.name);
        }
    }
    if (streetNames.length === 0)
        return false;
    segs.splice(0, 1);
    return segs.every(el => {
        if (el.attributes.primaryStreetID) {
            street = W.model.streets.getObjectById(el.attributes.primaryStreetID);
            if (street && street.name && (street.name.length > 0) && streetNames.includes(street.name))
                return true;
        }
        if (el.attributes.streetIDs.length > 0) {
            for (let i = 0; i < el.attributes.streetIDs.length; i++) {
                street = W.model.streets.getObjectById(el.attributes.streetIDs[i]);
                if (street && street.name && (street.name.length > 0) && streetNames.includes(street.name))
                    return true;
            }
        }
        return false;
    });
}

function findDirectRoute(obj = {}) {
    const {
            maxLength, segIds, startSeg, startNode, endSeg, endNodeIds
        } = obj,
        processedSegs = [startSeg.attributes.id],
        segIdsFilter = (nextSegIds, alreadyProcessed) => nextSegIds.filter(value => alreadyProcessed.indexOf(value) === -1),
        getNextSegs = (nextSegIds, curSeg, nextNode, idx) => {
            const rObj = { addPossibleRouteSegments: [], removePossibleRouteSegments: [] };
            for (let i = 0; i < nextSegIds.length; i++) {
                const nextSeg = W.model.segments.getObjectById(nextSegIds[i]);
                if (curSeg.isTurnAllowed(nextSeg, nextNode) && nameContinuityCheck([startSeg, nextSeg])) {
                    if (processedSegs.indexOf(nextSegIds[i]) === -1) {
                        rObj.addPossibleRouteSegments.push({ startNode: nextNode, seg: nextSeg });
                        processedSegs.push(nextSegIds[i]);
                    }
                }
            }
            if (rObj.addPossibleRouteSegments.length === 0)
                rObj.removePossibleRouteSegments.push(idx);
            return rObj;
        };
    let directRouteSegs = [];
    segIds.some(segId => {
        const seg = W.model.segments.getObjectById(segId);
        if (startSeg.isTurnAllowed(seg, startNode) && nameContinuityCheck([startSeg, seg])) {
            let possibleRouteSegments = [{ startNode, seg }],
                curLength = 0;
            while (possibleRouteSegments.length > 0) {
                const idx = possibleRouteSegments.length - 1,
                    curSeg = possibleRouteSegments[idx].seg,
                    nextNode = curSeg.getOtherNode(possibleRouteSegments[idx].startNode),
                    nextSegIds = segIdsFilter(nextNode.attributes.segIDs, possibleRouteSegments.map(routeSeg => routeSeg.seg.attributes.id));
                if (endNodeIds.indexOf(nextNode.attributes.id) > -1) {
                    directRouteSegs = [startSeg.attributes.id].concat(possibleRouteSegments.map(routeSeg => routeSeg.seg.attributes.id), [endSeg.attributes.id]);
                    possibleRouteSegments = [];
                    return true;
                }
                if ((curLength + curSeg.attributes.length) > maxLength) {
                    possibleRouteSegments.splice(idx, 1);
                    curLength -= curSeg.attributes.length;
                }
                else {
                    const nextSegsObj = getNextSegs(nextSegIds, curSeg, nextNode, idx);
                    if (nextSegsObj.removePossibleRouteSegments.length > 0) {
                        curLength -= curSeg.attributes.length;
                        possibleRouteSegments.splice(nextSegsObj.removePossibleRouteSegments[0], 1);
                    }
                    else {
                        curLength += curSeg.attributes.length;
                        for (let i = 0; i < nextSegsObj.addPossibleRouteSegments.length; i++)
                            possibleRouteSegments.push(nextSegsObj.addPossibleRouteSegments[i]);
                    }
                }
            }
        }
        return false;
    });
    return directRouteSegs;
}

async function doCheckBDP() {
    const selectedFeatures = W.selectionManager.getSelectedFeatures(),
        segmentSelection = W.selectionManager.getSegmentSelection(),
        numSelectedFeatureSegments = selectedFeatures.filter(feature => feature.model.type === 'segment').length;
    let jsonData,
        startSeg,
        endSeg,
        maxLength,
        directRoute = [];
    if ((segmentSelection.segments.length < 2) || (numSelectedFeatureSegments < 2)) {
        WazeWrap.Alerts.error(SCRIPT_NAME, 'You must select either the two <i>bracketing segments</i> or an entire detour route with <i>bracketing segments</i>.');
        return;
    }
    if (segmentSelection.multipleConnectedComponents && ((segmentSelection.segments.length > 2) || (numSelectedFeatureSegments < 2))) {
        WazeWrap.Alerts.error(SCRIPT_NAME,
            'If you select more than 2 segments, the selection of segments must be continuous.<br><br>'
            + 'Either select just the two bracketing segments or an entire detour route with bracketing segments.');
        return;
    }
    if (segmentSelection.segments.length === 2) {
        [startSeg, endSeg] = segmentSelection.segments;
    }
    else {
        const tempNodeIds = [];
        segmentSelection.segments.forEach(segment => {
            let idx = findObjIndex(tempNodeIds, 'nodeId', segment.attributes.fromNodeID);
            if (idx > -1)
                tempNodeIds.splice(idx, 1);
            else
                tempNodeIds.push({ nodeId: segment.attributes.fromNodeID, segId: segment.attributes.id });
            idx = findObjIndex(tempNodeIds, 'nodeId', segment.attributes.toNodeID);
            if (idx > -1)
                tempNodeIds.splice(idx, 1);
            else
                tempNodeIds.push({ nodeId: segment.attributes.toNodeID, segId: segment.attributes.id });
        });
        if (tempNodeIds.length !== 2) {
            logError('Error finding which two segments were the bracketing segments.');
            return;
        }
        startSeg = W.model.segments.getObjectById(tempNodeIds[0].segId);
        endSeg = W.model.segments.getObjectById(tempNodeIds[1].segId);
        endSeg.attributes.bdpcheck = { routeFarEndNodeId: tempNodeIds[1].nodeId };
        maxLength = (startSeg.attributes.roadType === 7) ? 5000 : 50000;
    }
    if ((startSeg.attributes.roadType < 3) || (startSeg.attributes.roadType === 4) || (startSeg.attributes.roadType === 5) || (startSeg.attributes.roadType > 7)
        || (endSeg.attributes.roadType < 3) || (endSeg.attributes.roadType === 4) || (endSeg.attributes.roadType === 5) || (endSeg.attributes.roadType > 7)
    ) {
        WazeWrap.Alerts.info(SCRIPT_NAME, 'At least one of the bracketing selected segments is not in the correct road type group for BDP.');
        return;
    }
    if (!rtgContinuityCheck([startSeg, endSeg])) {
        WazeWrap.Alerts.info(SCRIPT_NAME, 'One bracketing segment is a minor highway while the other is not. BDP only applies when bracketing segments are in the same road type group.');
        return;
    }
    if (segmentSelection.segments.length > 2) {
        // Detour route selected. Lets check BDP checkpoints.
        const routeSegIds = W.selectionManager.getSegmentSelection().getSelectedSegments()
                .map(segment => segment.attributes.id)
                .filter(segId => (segId !== endSeg.attributes.id) && (segId !== startSeg.attributes.id)),
            endNodeObj = endSeg.getOtherNode(W.model.nodes.getObjectById(endSeg.attributes.bdpcheck.routeFarEndNodeId)),
            startSegDirection = startSeg.getDirection(),
            startNodeObjs = (startSegDirection === 1) ? [startSeg.getToNode()] : (startSegDirection === 2) ? [startSeg.getFromNode()] : [startSeg.getToNode(), startSeg.getFromNode()],
            lastDetourSegId = routeSegIds.filter(el => endNodeObj.attributes.segIDs.includes(el)),
            lastDetourSeg = W.model.segments.getObjectById(lastDetourSegId),
            detourSegs = segmentSelection.segments.slice(1, -1);
        if (nameContinuityCheck([lastDetourSeg, endSeg])) {
            WazeWrap.Alerts.info(SCRIPT_NAME, 'BDP will not be applied to this detour route because the last detour segment and the second bracketing segment share a common street name.');
            return;
        }
        if (rtgContinuityCheck([lastDetourSeg, endSeg])) {
            WazeWrap.Alerts.info(SCRIPT_NAME, 'BDP will not be applied to this detour route because the last detour segment and the second bracketing segment are in the same road type group.');
            return;
        }
        if (detourSegs.length < 2) {
            WazeWrap.Alerts.info(SCRIPT_NAME, 'BDP will not be applied to this detour route because it is less than 2 segments long.');
            return;
        }
        if (detourSegs.map(seg => seg.attributes.length).reduce((a, b) => a + b) > ((startSeg.attributes.roadType === 7) ? 500 : 5000)) {
            WazeWrap.Alerts.info(SCRIPT_NAME, `BDP will not be applied to this detour route because it is longer than ${((startSeg.attributes.roadType === 7) ? '500m' : '5km')}.`);
            return;
        }
        // We have a preventable detour. Let's check for a direct route.
        for (let i = 0; i < startNodeObjs.length; i++) {
            const startNode = startNodeObjs[i],
                segIds = startNode.attributes.segIDs.filter(segId => segId !== startSeg.attributes.id);
            directRoute = findDirectRoute({
                maxLength, segIds, startSeg, startNode, endSeg, endNodeIds: [endNodeObj.attributes.id]
            });
            if (directRoute.length > 0)
                break;
        }
    }
    // Check bracketing segment name continuity
    if (!nameContinuityCheck([startSeg, endSeg])) {
        WazeWrap.Alerts.info(SCRIPT_NAME, 'The bracketing segments do not share a street name. BDP will not be applied to any route.');
        return;
    }
    // Let's check for a "direct route"
    // First check what is returned by the Live Map routing engine.
    const start900913center = startSeg.getCenter(),
        end900913center = endSeg.getCenter(),
        start4326Center = WazeWrap.Geometry.ConvertTo4326(start900913center.x, start900913center.y),
        end4326Center = WazeWrap.Geometry.ConvertTo4326(end900913center.x, end900913center.y),
        url = (W.model.countries.getObjectById(235) || W.model.countries.getObjectById(40) || W.model.countries.getObjectById(182))
            ? '/RoutingManager/routingRequest'
            : W.model.countries.getObjectById(106)
                ? '/il-RoutingManager/routingRequest'
                : '/row-RoutingManager/routingRequest',
        data = {
            from: `x:${start4326Center.lon} y:${start4326Center.lat}`,
            to: `x:${end4326Center.lon} y:${end4326Center.lat}`,
            returnJSON: true,
            returnGeometries: true,
            returnInstructions: false,
            timeout: 60000,
            type: 'HISTORIC_TIME',
            nPaths: 6,
            clientVersion: '4.0.0',
            vehType: 'PRIVATE',
            options: 'AVOID_TOLL_ROADS:f,AVOID_PRIMARIES:f,AVOID_DANGEROUS_TURNS:f,AVOID_FERRIES:f,ALLOW_UTURNS:t'
        };
    try {
        jsonData = await $.ajax({
            dataType: 'JSON',
            cache: false,
            url,
            data,
            traditional: true,
            dataFilter: retData => retData.replace(/NaN/g, '0')
        }).fail((response, textStatus, errorThrown) => { logWarning(`Route request failed ${(textStatus !== null ? `with ${textStatus}` : '')}\r\n${errorThrown}!`); });
    }
    catch (error) {
        logWarning(JSON.stringify(error));
    }
    if (!jsonData) {
        logWarning('No data returned.');
    }
    else if (jsonData.error !== undefined) {
        logWarning(jsonData.error.replace('|', '\r\n'));
    }
    else {
        let routes = (jsonData.coords !== undefined) ? [jsonData] : [];
        if (jsonData.alternatives !== undefined)
            routes = routes.concat(jsonData.alternatives);
        const directRouteObj = routes.find(el => {
            const fullRouteSegIds = el.response.results.map(result => result.path.segmentId),
                fullRouteSegs = W.model.segments.getByIds(fullRouteSegIds);
            if (nameContinuityCheck(fullRouteSegs) && rtgContinuityCheck(fullRouteSegs)) {
                // name and rtg continuity exists, let's check distance
                // using 5km for mH and 50km for MH-FW on purpose. This is because a true "detour path" shouldn't be longer than 500m or 5km respectively.
                const routeDistance = el.response.results.map(result => result.length).slice(1, -1).reduce((a, b) => a + b);
                if (routeDistance < maxLength)
                    return true;
            }
            return false;
        });
        if (directRouteObj !== undefined)
            directRoute = directRouteObj.response.results.map(result => result.path.segmentId);
    }
    // No direct route found from live-map routing. Let's try to do it manually.
    if (directRoute.length === 0) {
        const startSegDirection = startSeg.getDirection(),
            endSegDirection = endSeg.getDirection(),
            startNodeObjs = (startSegDirection === 1) ? [startSeg.getToNode()] : (startSegDirection === 2) ? [startSeg.getFromNode()] : [startSeg.getToNode(), startSeg.getFromNode()],
            endNodeObjs = (endSegDirection === 1) ? [endSeg.getFromNode()] : (endSegDirection === 2) ? [endSeg.getToNode()] : [endSeg.getFromNode(), endSeg.getToNode()],
            endNodeIds = endNodeObjs.map(nodeObj => nodeObj && nodeObj.attributes.id);
        for (let i = 0; i < startNodeObjs.length; i++) {
            const startNode = startNodeObjs[i],
                segIds = startNode.attributes.segIDs.filter(segId => segId !== startSeg.attributes.id);
            directRoute = findDirectRoute({
                maxLength, segIds, startSeg, startNode, endSeg, endNodeIds
            });
            if (directRoute.length > 0)
                break;
        }
    }
    if (directRoute.length > 0) {
        WazeWrap.Alerts.confirm(SCRIPT_NAME,
            'A <b>direct route</b> was found! Would you like to select the direct route?',
            () => {
                const segments = [];
                for (let i = 0; i < directRoute.length; i++) {
                    const seg = W.model.segments.getObjectById(directRoute[i]);
                    if (seg !== 'undefined')
                        segments.push(seg);
                }
                W.selectionManager.setSelectedModels(segments);
            },
            () => { }, 'Yes', 'No');
    }
    else if (segmentSelection.segments.length === 2) {
        WazeWrap.Alerts.info(SCRIPT_NAME,
            'No direct routes found between the two selected segments. A BDP penalty <b>will not</b> be applied to any routes.'
                + '<br><b>Note:</b> This could also be caused by the distance between the two selected segments is longer than than the allowed distance for detours.');
    }
    else {
        WazeWrap.Alerts.info(SCRIPT_NAME,
            'No direct routes found between the possible detour bracketing segments. A BDP penalty <b>will not</b> be applied to the selected route.'
                + '<br><b>Note:</b> This could also be because any possible direct routes are very long, which would take longer to travel than taking the selected route (even with penalty).');
    }
}

function insertCheckBDPButton(evt) {
    if (!evt || !evt.object || !evt.object._selectedFeatures || (evt.object._selectedFeatures.length < 2)) {
        if ($('#WME-BDPC').length > 0)
            $('#WME-BDPC').remove();
        return;
    }
    if (evt.object._selectedFeatures.filter(feature => feature.model.type === 'segment').length > 1) {
        $('.edit-restrictions').after(
            '<button id="WME-BDPC" class="waze-btn waze-btn-small waze-btn-white" title="Check if there are possible BDP routes between two selected segments.">BDP Check</button>'
        );
    }
    else if ($('#WME-BDPC').length > 0) {
        $('#WME-BDPC').remove();
    }
}

async function init() {
    log('Initializing.');
    await loadSettingsFromStorage();
    W.selectionManager.events.register('selectionchanged', null, insertCheckBDPButton);
    if (W.selectionManager.getSegmentSelection().segments.length > 1) {
        $('.edit-restrictions').after(
            '<button id="WME-BDPC" class="waze-btn waze-btn-small waze-btn-white" title="Check if there are possible BDP routes between two selected segments.">BDP Check</button>'
        );
    }
    $('#sidebar').on('click', '#WME-BDPC', e => {
        e.preventDefault();
        doCheckBDP();
    });
    showScriptInfoAlert();
    log(`Fully initialized in ${Math.round(performance.now() - LOAD_BEGIN_TIME)} ms.`);
}

function bootstrap(tries) {
    if (W && W.map && W.model && $ && WazeWrap.Ready) {
        checkTimeout({ timeout: 'bootstrap' });
        log('Bootstrapping.');
        init();
    }
    else if (tries < 1000) {
        logDebug(`Bootstrap failed. Retrying ${tries} of 1000`);
        _timeouts.bootstrap = window.setTimeout(bootstrap, 200, ++tries);
    }
    else {
        logError('Bootstrap timed out waiting for WME to become ready.');
    }
}

bootstrap(1);
