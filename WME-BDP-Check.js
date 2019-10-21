/* eslint-disable no-nested-ternary */
// ==UserScript==
// @name        WME BDP Check (beta)
// @namespace   https://greasyfork.org/users/166843
// @version     2019.10.21.01
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
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    _timeouts = { bootstrap: undefined, saveSettingsToStorage: undefined };
let _settings = {},
    _pathEndSegId,
    _restoreZoomLevel,
    _restoreMapCenter;

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

function getMidpoint(startSeg, endSeg) {
    let startCenter = startSeg.getCenter(),
        endCenter = endSeg.getCenter();
    startCenter = WazeWrap.Geometry.ConvertTo4326(startCenter.x, startCenter.y);
    endCenter = WazeWrap.Geometry.ConvertTo4326(endCenter.x, endCenter.y);
    let lon1 = startCenter.lon,
        lat1 = startCenter.lat,
        lat2 = endCenter.lat;
    const piDiv = Math.PI / 180,
        divPi = 180 / Math.PI,
        lon2 = endCenter.lon,
        dLon = ((lon2 - lon1) * piDiv);
    lat1 *= piDiv;
    lat2 *= piDiv;
    lon1 *= piDiv;
    const bX = Math.cos(lat2) * Math.cos(dLon),
        bY = Math.cos(lat2) * Math.sin(dLon),
        lat3 = (Math.atan2(Math.sin(lat1) + Math.sin(lat2), Math.sqrt((Math.cos(lat1) + bX) * (Math.cos(lat1) + bX) + bY * bY))) * divPi,
        lon3 = (lon1 + Math.atan2(bY, Math.cos(lat1) + bX)) * divPi;
    return WazeWrap.Geometry.ConvertTo900913(lon3, lat3);
}

function doZoom(restore = false, zoom = -1, coordObj = {}) {
    return new Promise(async resolve => {
        if ((zoom === -1) || (Object.entries(coordObj).length === 0))
            return;
        W.map.setCenter(coordObj);
        if (restore || (W.map.getZoom() > zoom))
            W.map.zoomTo(zoom);
        if (restore) {
            _restoreZoomLevel = undefined;
            _restoreMapCenter = undefined;
        }
        else {
            WazeWrap.Alerts.info(SCRIPT_NAME, 'Waiting for WME to populate after zoom level change.<br>Proceeding in 2 seconds...');
            await sleep(2000);
            $('#toast-container-wazedev > .toast-info').find('.toast-close-button').click();
        }
        resolve();
    });
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

function findLiveMapRoutes(startSeg, endSeg, maxLength) {
    return new Promise(async resolve => {
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
            },
            returnRoutes = [];
        let jsonData;
        try {
            jsonData = await $.ajax({
                dataType: 'JSON',
                cache: false,
                url,
                data,
                traditional: true,
                dataFilter: retData => retData.replace(/NaN/g, '0')
            }).fail((response, textStatus, errorThrown) => {
                logWarning(`Route request failed ${(textStatus !== null ? `with ${textStatus}` : '')}\r\n${errorThrown}!`);
            });
        }
        catch (error) {
            logWarning(JSON.stringify(error));
            jsonData = { error };
        }
        if (!jsonData) {
            logWarning('No data returned.');
        }
        else if (jsonData.error !== undefined) {
            logWarning(((typeof jsonData.error === 'object') ? $.parseJSON(jsonData.error) : jsonData.error.replace('|', '\r\n')));
        }
        else {
            let routes = (jsonData.coords !== undefined) ? [jsonData] : [];
            if (jsonData.alternatives !== undefined)
                routes = routes.concat(jsonData.alternatives);
            routes.forEach(route => {
                const fullRouteSegIds = route.response.results.map(result => result.path.segmentId),
                    fullRouteSegs = W.model.segments.getByIds(fullRouteSegIds);
                if (nameContinuityCheck(fullRouteSegs) && rtgContinuityCheck(fullRouteSegs)) {
                    const routeDistance = route.response.results.map(result => result.length).slice(1, -1).reduce((a, b) => a + b);
                    if (routeDistance < maxLength)
                        returnRoutes.push(route.response.results.map(result => result.path.segmentId));
                }
            });
        }
        resolve(returnRoutes);
    });
}

function findDirectRoute(obj = {}) {
    const {
            maxLength, startSeg, startNode, endSeg, endNodeIds
        } = obj,
        processedSegs = [],
        sOutIds = startNode.attributes.segIDs.filter(segId => segId !== startSeg.attributes.id),
        segIdsFilter = (nextSegIds, alreadyProcessed) => nextSegIds.filter(value => alreadyProcessed.indexOf(value) === -1),
        getNextSegs = (nextSegIds, curSeg, nextNode) => {
            const rObj = { addPossibleRouteSegments: [] };
            for (let i = 0; i < nextSegIds.length; i++) {
                const nextSeg = W.model.segments.getObjectById(nextSegIds[i]);
                if (curSeg.isTurnAllowed(nextSeg, nextNode) && nameContinuityCheck([startSeg, nextSeg])) {
                    if (!processedSegs.some(o => (o.fromSegId === curSeg.attributes.id) && (o.toSegId === nextSegIds[i]))) {
                        rObj.addPossibleRouteSegments.push({ nextSegStartNode: nextNode, nextSeg });
                        break;
                    }
                }
            }
            return rObj;
        },
        returnRoutes = [];
    for (let i = 0, len = sOutIds.length; i < len; i++) {
        const sOut = W.model.segments.getObjectById(sOutIds[i]);
        if (startSeg.isTurnAllowed(sOut, startNode) && nameContinuityCheck([startSeg, sOut])) {
            const possibleRouteSegments = [{
                curSeg: startSeg,
                nextSegStartNode: startNode,
                nextSeg: sOut
            }];
            let curLength = 0;
            while (possibleRouteSegments.length > 0) {
                const idx = possibleRouteSegments.length - 1,
                    curSeg = possibleRouteSegments[idx].nextSeg,
                    curSegStartNode = possibleRouteSegments[idx].nextSegStartNode,
                    curSegEndNode = curSeg.getOtherNode(curSegStartNode),
                    curSegEndNodeSOutIds = segIdsFilter(curSegEndNode.attributes.segIDs, possibleRouteSegments.map(routeSeg => routeSeg.nextSeg.attributes.id));
                if ((endNodeIds.indexOf(curSegEndNode.attributes.id) > -1) && curSeg.isTurnAllowed(endSeg, curSegEndNode)) {
                    returnRoutes.push([startSeg.attributes.id].concat(possibleRouteSegments.map(routeSeg => routeSeg.nextSeg.attributes.id), [endSeg.attributes.id]));
                    possibleRouteSegments.splice(idx, 1);
                }
                else if ((curLength + curSeg.attributes.length) > maxLength) {
                    possibleRouteSegments.splice(idx, 1);
                    curLength -= curSeg.attributes.length;
                }
                else {
                    const nextSegObj = getNextSegs(curSegEndNodeSOutIds, curSeg, curSegEndNode);
                    if (nextSegObj.addPossibleRouteSegments.length > 0) {
                        curLength += curSeg.attributes.length;
                        possibleRouteSegments.push(nextSegObj.addPossibleRouteSegments[0]);
                        processedSegs.push({ fromSegId: curSeg.attributes.id, toSegId: nextSegObj.addPossibleRouteSegments[0].nextSeg.attributes.id });
                    }
                    else {
                        curLength -= curSeg.attributes.length;
                        possibleRouteSegments.splice(idx, 1);
                    }
                }
            }
            if (returnRoutes.length > 0)
                break;
        }
        else {
            processedSegs.push({ fromSegId: startSeg.attributes.id, toSegId: sOut.attributes.id });
        }
    }
    return returnRoutes;
}

async function doCheckBDP(viaLM = false) {
    const selectedFeatures = W.selectionManager.getSelectedFeatures(),
        segmentSelection = W.selectionManager.getSegmentSelection(),
        numSelectedFeatureSegments = selectedFeatures.filter(feature => feature.model.type === 'segment').length;
    let startSeg,
        endSeg,
        directRoutes = [];
    if ((segmentSelection.segments.length < 2) || (numSelectedFeatureSegments < 2)) {
        WazeWrap.Alerts.error(SCRIPT_NAME, 'You must select either the two <i>bracketing segments</i> or an entire detour route with <i>bracketing segments</i>.');
        return;
    }
    if (segmentSelection.multipleConnectedComponents && ((segmentSelection.segments.length > 2) || (numSelectedFeatureSegments > 2))) {
        WazeWrap.Alerts.error(SCRIPT_NAME,
            'If you select more than 2 segments, the selection of segments must be continuous.<br><br>'
            + 'Either select just the two bracketing segments or an entire detour route with bracketing segments.');
        return;
    }
    if (segmentSelection.segments.length === 2) {
        [startSeg, endSeg] = segmentSelection.segments;
    }
    else if (_pathEndSegId !== undefined) {
        startSeg = W.model.segments.getObjectById(segmentSelection.segments[segmentSelection.segments.length - 1].attributes.id);
        endSeg = W.model.segments.getObjectById(_pathEndSegId);
        const routeNodeIds = segmentSelection.segments.slice(1, -1).flatMap(segment => [segment.attributes.toNodeID, segment.attributes.fromNodeID]);
        if (routeNodeIds.some(nodeId => endSeg.attributes.fromNodeID === nodeId))
            endSeg.attributes.bdpcheck = { routeFarEndNodeId: endSeg.attributes.toNodeID };
        else
            endSeg.attributes.bdpcheck = { routeFarEndNodeId: endSeg.attributes.fromNodeID };
    }
    else {
        const tempNodeIds = [];
        segmentSelection.segments.forEach(segment => {
            let idx = tempNodeIds.map(tempNodeId => tempNodeId.nodeId).indexOf(segment.attributes.fromNodeID);
            if (idx > -1)
                tempNodeIds.splice(idx, 1);
            else
                tempNodeIds.push({ nodeId: segment.attributes.fromNodeID, segId: segment.attributes.id });
            idx = tempNodeIds.map(tempNodeId => tempNodeId.nodeId).indexOf(segment.attributes.toNodeID);
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
    const maxLength = (startSeg.attributes.roadType === 7) ? 5000 : 50000;
    if (((startSeg.attributes.roadType === 7) && (W.map.getZoom() > 4))
        || ((startSeg.attributes.roadType !== 7) && (W.map.getZoom() > 3))) {
        _restoreZoomLevel = W.map.getZoom();
        _restoreMapCenter = W.map.getCenter();
        await doZoom(false, (startSeg.attributes.roadType === 7) ? 4 : 3, getMidpoint(startSeg, endSeg));
    }
    if (segmentSelection.segments.length > 2) {
        const routeSegIds = W.selectionManager.getSegmentSelection().getSelectedSegments()
                .map(segment => segment.attributes.id)
                .filter(segId => (segId !== endSeg.attributes.id) && (segId !== startSeg.attributes.id)),
            endNodeObj = endSeg.getOtherNode(W.model.nodes.getObjectById(endSeg.attributes.bdpcheck.routeFarEndNodeId)),
            startSegDirection = startSeg.getDirection(),
            startNodeObjs = [],
            lastDetourSegId = routeSegIds.filter(el => endNodeObj.attributes.segIDs.includes(el)),
            lastDetourSeg = W.model.segments.getObjectById(lastDetourSegId),
            detourSegs = segmentSelection.segments.slice(1, -1);
        if ((startSegDirection !== 2) && startSeg.getToNode())
            startNodeObjs.push(startSeg.getToNode());
        if ((startSegDirection !== 1) && startSeg.getFromNode())
            startNodeObjs.push(startSeg.getFromNode());
        if (nameContinuityCheck([lastDetourSeg, endSeg])) {
            WazeWrap.Alerts.info(SCRIPT_NAME, 'BDP will not be applied to this detour route because the last detour segment and the second bracketing segment share a common street name.');
            doZoom(true, _restoreZoomLevel, _restoreMapCenter);
            return;
        }
        if (rtgContinuityCheck([lastDetourSeg, endSeg])) {
            WazeWrap.Alerts.info(SCRIPT_NAME, 'BDP will not be applied to this detour route because the last detour segment and the second bracketing segment are in the same road type group.');
            doZoom(true, _restoreZoomLevel, _restoreMapCenter);
            return;
        }
        if (detourSegs.length < 2) {
            WazeWrap.Alerts.info(SCRIPT_NAME, 'BDP will not be applied to this detour route because it is less than 2 segments long.');
            doZoom(true, _restoreZoomLevel, _restoreMapCenter);
            return;
        }
        if (detourSegs.map(seg => seg.attributes.length).reduce((a, b) => a + b) > ((startSeg.attributes.roadType === 7) ? 500 : 5000)) {
            WazeWrap.Alerts.info(SCRIPT_NAME, `BDP will not be applied to this detour route because it is longer than ${((startSeg.attributes.roadType === 7) ? '500m' : '5km')}.`);
            doZoom(true, _restoreZoomLevel, _restoreMapCenter);
            return;
        }
        if (viaLM) {
            directRoutes = directRoutes.concat(await findLiveMapRoutes(startSeg, endSeg, maxLength));
        }
        else {
            for (let i = 0; i < startNodeObjs.length; i++) {
                const startNode = startNodeObjs[i];
                directRoutes = findDirectRoute({
                    maxLength, startSeg, startNode, endSeg, endNodeIds: [endNodeObj.attributes.id]
                });
                if (directRoutes.length > 0)
                    break;
            }
        }
    }
    else {
        if (!nameContinuityCheck([startSeg, endSeg])) {
            WazeWrap.Alerts.info(SCRIPT_NAME, 'The bracketing segments do not share a street name. BDP will not be applied to any route.');
            doZoom(true, _restoreZoomLevel, _restoreMapCenter);
            return;
        }
        if (viaLM) {
            directRoutes = directRoutes.concat(await findLiveMapRoutes(startSeg, endSeg, maxLength));
        }
        else {
            const startSegDirection = startSeg.getDirection(),
                endSegDirection = endSeg.getDirection();
            const startNodeObjs = [],
                endNodeObjs = [];
            if ((startSegDirection !== 2) && startSeg.getToNode())
                startNodeObjs.push(startSeg.getToNode());
            if ((startSegDirection !== 1) && startSeg.getFromNode())
                startNodeObjs.push(startSeg.getFromNode());
            if ((endSegDirection !== 2) && endSeg.getFromNode())
                endNodeObjs.push(endSeg.getFromNode());
            if ((endSegDirection !== 1) && endSeg.getToNode())
                endNodeObjs.push(endSeg.getToNode());
            for (let i = 0; i < startNodeObjs.length; i++) {
                const startNode = startNodeObjs[i];
                directRoutes = findDirectRoute({
                    maxLength, startSeg, startNode, endSeg, endNodeIds: endNodeObjs.map(nodeObj => nodeObj && nodeObj.attributes.id)
                });
                if (directRoutes.length > 0)
                    break;
            }
        }
    }
    if (directRoutes.length > 0) {
        WazeWrap.Alerts.confirm(SCRIPT_NAME,
            'A <b>direct route</b> was found! Would you like to select the direct route?',
            () => {
                const segments = [];
                for (let i = 0; i < directRoutes[0].length; i++) {
                    const seg = W.model.segments.getObjectById(directRoutes[0][i]);
                    if (seg !== 'undefined')
                        segments.push(seg);
                }
                W.selectionManager.setSelectedModels(segments);
                doZoom(true, _restoreZoomLevel, _restoreMapCenter);
            },
            () => { doZoom(true, _restoreZoomLevel, _restoreMapCenter); }, 'Yes', 'No');
    }
    else if (segmentSelection.segments.length === 2) {
        WazeWrap.Alerts.info(SCRIPT_NAME,
            'No direct routes found between the two selected segments. A BDP penalty <b>will not</b> be applied to any routes.'
                + '<br><b>Note:</b> This could also be caused by the distance between the two selected segments is longer than than the allowed distance for detours.');
        doZoom(true, _restoreZoomLevel, _restoreMapCenter);
    }
    else {
        WazeWrap.Alerts.info(SCRIPT_NAME,
            'No direct routes found between the possible detour bracketing segments. A BDP penalty <b>will not</b> be applied to the selected route.'
                + '<br><b>Note:</b> This could also be because any possible direct routes are very long, which would take longer to travel than taking the selected route (even with penalty).');
        doZoom(true, _restoreZoomLevel, _restoreMapCenter);
    }
}

function insertCheckBDPButton(evt) {
    const $wmeButton = $('#WME-BDPC-WME'),
        $lmButton = $('#WME-BDPC-LM');
    if (!evt || !evt.object || !evt.object._selectedFeatures || (evt.object._selectedFeatures.length < 2)) {
        if ($wmeButton.length > 0)
            $wmeButton.remove();
        if ($lmButton.length > 0)
            $lmButton.remove();
        return;
    }
    if (evt.object._selectedFeatures.filter(feature => feature.model.type === 'segment').length > 1) {
        let htmlOut = '';
        if ($wmeButton.length === 0)
            htmlOut += '<button id="WME-BDPC-WME" class="waze-btn waze-btn-small waze-btn-white" title="Check BDP of selected segments, via WME.">BDP Check (WME)</button>';
        if ($lmButton.length === 0)
            htmlOut += '<button id="WME-BDPC-LM" class="waze-btn waze-btn-small waze-btn-white" title="Check BDP of selected segments, via LM.">BDP Check (LM)</button>';
        if (htmlOut !== '')
            $('.edit-restrictions').before(htmlOut);
        return;
    }
    if ($wmeButton.length > 0)
        $wmeButton.remove();
    if ($lmButton.length > 0)
        $lmButton.remove();
}

function pathSelected(evt) {
    if (evt && evt.feature && evt.feature.model && (evt.feature.model.type === 'segment'))
        _pathEndSegId = evt.feature.model.attributes.id;
}

async function init() {
    log('Initializing.');
    await loadSettingsFromStorage();
    W.selectionManager.events.register('selectionchanged', null, insertCheckBDPButton);
    W.selectionManager.selectionMediator.on('map:selection:pathSelect', pathSelected);
    W.selectionManager.selectionMediator.on('map:selection:featureClick', () => { _pathEndSegId = undefined; });
    W.selectionManager.selectionMediator.on('map:selection:clickOut', () => { _pathEndSegId = undefined; });
    W.selectionManager.selectionMediator.on('map:selection:deselectKey', () => { _pathEndSegId = undefined; });
    W.selectionManager.selectionMediator.on('map:selection:featureBoxSelection', () => { _pathEndSegId = undefined; });
    if (W.selectionManager.getSegmentSelection().segments.length > 1) {
        $('.edit-restrictions').before(
            '<button id="WME-BDPC-WME" class="waze-btn waze-btn-small waze-btn-white" title="Check if there are possible BDP routes between two selected segments, via WME.">BDP Check (WME)</button>',
            '<button id="WME-BDPC-LM" class="waze-btn waze-btn-small waze-btn-white" title="Check if there are possible BDP routes between two selected segments, via LM.">BDP Check (LM)</button>'
        );
    }
    $('#sidebar').on('click', '#WME-BDPC-WME', e => {
        e.preventDefault();
        doCheckBDP(false);
    });
    $('#sidebar').on('click', '#WME-BDPC-LM', e => {
        e.preventDefault();
        doCheckBDP(true);
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
