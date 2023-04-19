// ==UserScript==
// @name        WME BDP Check
// @namespace   https://greasyfork.org/users/166843
// @version     2023.04.19.01
// @description Check for possible BDP routes between two selected segments.
// @author      dBsooner
// @match       http*://*.waze.com/*editor*
// @exclude     http*://*.waze.com/user/editor*
// @require     https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @grant       GM_xmlhttpRequest
// @connect     greasyfork.org
// @license     GPLv3
// ==/UserScript==

/* global $, GM_info, GM_xmlhttpRequest, W, WazeWrap */

(function () {
    'use strict';

    // eslint-disable-next-line no-nested-ternary
    const _SCRIPT_SHORT_NAME = `WME BDPC${(/beta/.test(GM_info.script.name) ? ' β' : /\(DEV\)/i.test(GM_info.script.name) ? ' Ω' : '')}`,
        _SCRIPT_LONG_NAME = GM_info.script.name,
        _IS_ALPHA_VERSION = /[Ω]/.test(_SCRIPT_SHORT_NAME),
        _IS_BETA_VERSION = /[β]/.test(_SCRIPT_SHORT_NAME),
        _SCRIPT_AUTHOR = GM_info.script.author,
        _PROD_URL = 'https://greasyfork.org/scripts/393407-wme-bdp-check/code/WME%20BDP%20Check.user.js',
        _PROD_META_URL = 'https://greasyfork.org/scripts/393407-wme-bdp-check/code/WME%20BDP%20Check.meta.js',
        _FORUM_URL = 'https://www.waze.com/forum/viewtopic.php?f=819&t=294789',
        _SETTINGS_STORE_NAME = 'WMEBDPC',
        _BETA_URL = 'YUhSMGNITTZMeTluY21WaGMzbG1iM0pyTG05eVp5OXpZM0pwY0hSekx6TTVNVEkzTVMxM2JXVXRZbVJ3TFdOb1pXTnJMV0psZEdFdlkyOWtaUzlYVFVVbE1qQkNSRkFsTWpCRGFHVmpheVV5TUNoaVpYUmhLUzUxYzJWeUxtcHo=',
        _BETA_META_URL = 'YUhSMGNITTZMeTluY21WaGMzbG1iM0pyTG05eVp5OXpZM0pwY0hSekx6TTVNVEkzTVMxM2JXVXRZbVJ3TFdOb1pXTnJMV0psZEdFdlkyOWtaUzlYVFVVbE1qQkNSRkFsTWpCRGFHVmpheVV5TUNoaVpYUmhLUzV0WlhSaExtcHo=',
        _ALERT_UPDATE = true,
        _SCRIPT_VERSION = GM_info.script.version,
        _SCRIPT_VERSION_CHANGES = ['<b>CHANGE:</b> WME production now includes function from WME beta.'],
        _DEBUG = /[βΩ]/.test(_SCRIPT_SHORT_NAME),
        _LOAD_BEGIN_TIME = performance.now(),
        sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        dec = (s = '') => atob(atob(s)),
        _timeouts = { onWmeReady: undefined, saveSettingsToStorage: undefined },
        _editPanelObserver = new MutationObserver((mutations) => {
            if (W.selectionManager.getSegmentSelection().segments.length === 0)
                return;
            mutations.forEach((mutation) => {
                for (let i = 0; i < mutation.addedNodes.length; i++) {
                    const addedNode = mutation.addedNodes[i];
                    if (addedNode.nodeType === Node.ELEMENT_NODE) {
                        if (addedNode.querySelector('#segment-edit-general .form-group.more-actions')) {
                            if (W.selectionManager.getSegmentSelection().segments.length < 2) {
                                if ($('#WME-BDPC-WME').length > 0)
                                    $('#WME-BDPC-WME').remove();
                                if ($('#WME-BDPC-LM').length > 0)
                                    $('#WME-BDPC-LM').remove();
                            }
                            else if (W.selectionManager.getSegmentSelection().segments.length > 1) {
                                insertCheckBDPButton();
                            }
                        }
                    }
                }
            });
        });
    let _settings = {},
        _lastVersionChecked = '0',
        _pathEndSegId,
        _restoreZoomLevel,
        _restoreMapCenter;

    function log(message, data = '') { console.log(`${_SCRIPT_SHORT_NAME}:`, message, data); }
    function logError(message, data = '') { console.error(`${_SCRIPT_SHORT_NAME}:`, new Error(message), data); }
    function logWarning(message, data = '') { console.warn(`${_SCRIPT_SHORT_NAME}:`, message, data); }
    function logDebug(message, data = '') {
        if (_DEBUG)
            log(message, data);
    }

    async function loadSettingsFromStorage() {
        const defaultSettings = {
                lastSaved: 0,
                lastVersion: undefined
            },
            loadedSettings = $.parseJSON(localStorage.getItem(_SETTINGS_STORE_NAME)),
            serverSettings = await WazeWrap.Remote.RetrieveSettings(_SETTINGS_STORE_NAME);
        _settings = $.extend({}, defaultSettings, loadedSettings);
        if (serverSettings?.lastSaved > _settings.lastSaved)
            $.extend(_settings, serverSettings);
        _timeouts.saveSettingsToStorage = window.setTimeout(saveSettingsToStorage, 5000);
        return Promise.resolve();
    }

    function saveSettingsToStorage() {
        checkTimeout({ timeout: 'saveSettingsToStorage' });
        if (localStorage) {
            _settings.lastVersion = _SCRIPT_VERSION;
            _settings.lastSaved = Date.now();
            localStorage.setItem(_SETTINGS_STORE_NAME, JSON.stringify(_settings));
            WazeWrap.Remote.SaveSettings(_SETTINGS_STORE_NAME, _settings);
            logDebug('Settings saved.');
        }
    }

    function showScriptInfoAlert() {
        if (_ALERT_UPDATE && (_SCRIPT_VERSION !== _settings.lastVersion)) {
            let releaseNotes = '';
            releaseNotes += '<p>What\'s new:</p>';
            if (_SCRIPT_VERSION_CHANGES.length > 0) {
                releaseNotes += '<ul>';
                for (let idx = 0; idx < _SCRIPT_VERSION_CHANGES.length; idx++)
                    releaseNotes += `<li>${_SCRIPT_VERSION_CHANGES[idx]}`;
                releaseNotes += '</ul>';
            }
            else {
                releaseNotes += '<ul><li>Nothing major.</ul>';
            }
            WazeWrap.Interface.ShowScriptUpdate(_SCRIPT_SHORT_NAME, _SCRIPT_VERSION, releaseNotes, (_IS_BETA_VERSION ? dec(_BETA_URL) : _PROD_URL).replace(/code\/.*\.js/, ''), _FORUM_URL);
        }
    }

    function checkTimeout(obj) {
        if (obj.toIndex) {
            if (_timeouts[obj.timeout]?.[obj.toIndex]) {
                window.clearTimeout(_timeouts[obj.timeout][obj.toIndex]);
                delete (_timeouts[obj.timeout][obj.toIndex]);
            }
        }
        else {
            if (_timeouts[obj.timeout])
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

    async function doZoom(restore = false, zoom = -1, coordObj = {}) {
        if ((zoom === -1) || (Object.entries(coordObj).length === 0))
            return Promise.resolve();
        W.map.setCenter(coordObj);
        if (W.map.getZoom() !== zoom)
            W.map.getOLMap().zoomTo(zoom);
        if (restore) {
            _restoreZoomLevel = null;
            _restoreMapCenter = undefined;
        }
        else {
            WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, 'Waiting for WME to populate after zoom level change.<br>Proceeding in 2 seconds...');
            await sleep(2000);
            $('#toast-container-wazedev > .toast-info').find('.toast-close-button').click();
        }
        return Promise.resolve();
    }

    function rtgContinuityCheck([...segs] = []) {
        if (segs.length < 2)
            return false;
        const rtg = { 7: 'mH', 6: 'MHFW', 3: 'MHFW' },
            seg1rtg = rtg[segs[0].attributes.roadType];
        segs.splice(0, 1);
        return segs.every((el) => seg1rtg === rtg[el.attributes.roadType]);
    }

    function nameContinuityCheck([...segs] = []) {
        if (segs.length < 2)
            return false;
        const bs1StreetNames = [],
            bs2StreetNames = [],
            streetNames = [];
        let street;
        if (segs[0].attributes.primaryStreetID) {
            street = W.model.streets.getObjectById(segs[0].attributes.primaryStreetID);
            if (street?.name?.length > 0) {
                if (segs.length === 2)
                    streetNames.push(street.name);
                else
                    bs1StreetNames.push(street.name);
            }
        }
        if (segs[0].attributes.streetIDs.length > 0) {
            for (let i = 0; i < segs[0].attributes.streetIDs.length; i++) {
                street = W.model.streets.getObjectById(segs[0].attributes.streetIDs[i]);
                if (street?.name?.length > 0) {
                    if (segs.length === 2)
                        streetNames.push(street.name);
                    else
                        bs1StreetNames.push(street.name);
                }
            }
        }
        if (((segs.length === 2) && (streetNames.length === 0))
        || ((segs.length > 2) && (bs1StreetNames.length === 0)))
            return false;
        if (segs.length === 2) {
            if (segs[1].attributes.primaryStreetID) {
                street = W.model.streets.getObjectById(segs[1].attributes.primaryStreetID);
                if (street?.name && streetNames.includes(street.name))
                    return true;
            }
            if (segs[1].attributes.streetIDs.length > 0) {
                for (let i = 0; i < segs[1].attributes.streetIDs.length; i++) {
                    street = W.model.streets.getObjectById(segs[1].attributes.streetIDs[i]);
                    if (street?.name && streetNames.includes(street.name))
                        return true;
                }
            }
        }
        else {
            segs.splice(0, 1);
            const lastIdx = segs.length - 1;
            if (segs[lastIdx].attributes.primaryStreetID) {
                street = W.model.streets.getObjectById(segs[lastIdx].attributes.primaryStreetID);
                if (street?.name && (street.name.length > 0))
                    bs2StreetNames.push(street.name);
            }
            if (segs[lastIdx].attributes.streetIDs.length > 0) {
                for (let i = 0; i < segs[lastIdx].attributes.streetIDs.length; i++) {
                    street = W.model.streets.getObjectById(segs[lastIdx].attributes.streetIDs[i]);
                    if (street?.name && (street.name.length > 0))
                        bs2StreetNames.push(street.name);
                }
            }
            if (bs2StreetNames.length === 0)
                return false;
            segs.splice(-1, 1);
            return segs.every((el) => {
                if (el.attributes.primaryStreetID) {
                    street = W.model.streets.getObjectById(el.attributes.primaryStreetID);
                    if (street?.name && (bs1StreetNames.includes(street.name) || bs2StreetNames.includes(street.name)))
                        return true;
                }
                if (el.attributes.streetIDs.length > 0) {
                    for (let i = 0; i < el.attributes.streetIDs.length; i++) {
                        street = W.model.streets.getObjectById(el.attributes.streetIDs[i]);
                        if (street?.name && (bs1StreetNames.includes(street.name) || bs2StreetNames.includes(street.name)))
                            return true;
                    }
                }
                return false;
            });
        }
        return false;
    }

    async function findLiveMapRoutes(startSeg, endSeg, maxLength) {
        const start900913center = startSeg.getCenter(),
            end900913center = endSeg.getCenter(),
            start4326Center = WazeWrap.Geometry.ConvertTo4326(start900913center.x, start900913center.y),
            end4326Center = WazeWrap.Geometry.ConvertTo4326(end900913center.x, end900913center.y),
            // eslint-disable-next-line no-nested-ternary
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
        let jsonData = { error: false };
        try {
            jsonData = await $.ajax({
                dataType: 'JSON',
                cache: false,
                url,
                data,
                traditional: true,
                dataFilter: (retData) => retData.replace(/NaN/g, '0')
            }).fail((response, textStatus, errorThrown) => {
                logWarning(`Route request failed ${(textStatus ? `with ${textStatus}` : '')}\r\n${errorThrown}!\r\nResponse: ${response}`);
            });
        }
        catch (error) {
            logWarning(JSON.stringify(error));
            jsonData = { error };
        }
        if (!jsonData) {
            logWarning('No data returned.');
        }
        else if (jsonData.error) {
            logWarning(((typeof jsonData.error === 'object') ? $.parseJSON(jsonData.error) : jsonData.error.replace('|', '\r\n')));
        }
        else {
            let routes = jsonData.coords ? [jsonData] : [];
            if (jsonData.alternatives)
                routes = routes.concat(jsonData.alternatives);
            routes.forEach((route) => {
                const fullRouteSegIds = route.response.results.map((result) => result.path.segmentId),
                    fullRouteSegs = W.model.segments.getByIds(fullRouteSegIds);
                if (nameContinuityCheck(fullRouteSegs) && rtgContinuityCheck(fullRouteSegs)) {
                    const routeDistance = route.response.results.map((result) => result.length).slice(1, -1).reduce((a, b) => a + b);
                    if (routeDistance < maxLength)
                        returnRoutes.push(route.response.results.map((result) => result.path.segmentId));
                }
            });
        }
        return new Promise((resolve) => resolve(returnRoutes));
    }

    function findDirectRoute(obj = {}) {
        const {
                maxLength, startSeg, startNode, endSeg, endNodeIds
            } = obj,
            processedSegs = [],
            sOutIds = startNode.attributes.segIDs.filter((segId) => segId !== startSeg.attributes.id),
            segIdsFilter = (nextSegIds, alreadyProcessed) => nextSegIds.filter((value) => alreadyProcessed.indexOf(value) === -1),
            getNextSegs = (nextSegIds, curSeg, nextNode) => {
                const rObj = { addPossibleRouteSegments: [] };
                for (let i = 0; i < nextSegIds.length; i++) {
                    const nextSeg = W.model.segments.getObjectById(nextSegIds[i]);
                    if ((nextNode.isTurnAllowedBySegDirections(curSeg, nextSeg) || curSeg.isTurnAllowed(nextSeg, nextNode))
                    && nameContinuityCheck([curSeg, nextSeg])
                    && (nameContinuityCheck([startSeg, nextSeg]) || nameContinuityCheck([endSeg, nextSeg]))
                    ) {
                        if (!processedSegs.some((o) => (o.fromSegId === curSeg.attributes.id) && (o.toSegId === nextSegIds[i]))) {
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
            if ((startNode.isTurnAllowedBySegDirections(startSeg, sOut) || startSeg.isTurnAllowed(sOut, startNode)) && nameContinuityCheck([startSeg, sOut])) {
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
                        curSegEndNodeSOutIds = segIdsFilter(curSegEndNode.attributes.segIDs, possibleRouteSegments.map((routeSeg) => routeSeg.nextSeg.attributes.id));
                    if ((endNodeIds.indexOf(curSegEndNode.attributes.id) > -1) && (curSegEndNode.isTurnAllowedBySegDirections(curSeg, endSeg) || curSeg.isTurnAllowed(endSeg, curSegEndNode))) {
                        returnRoutes.push([startSeg.attributes.id].concat(possibleRouteSegments.map((routeSeg) => routeSeg.nextSeg.attributes.id), [endSeg.attributes.id]));
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
        const segmentSelection = W.selectionManager.getSegmentSelection();
        let startSeg,
            endSeg,
            directRoutes = [];
        if (segmentSelection.segments.length < 2) {
            insertCheckBDPButton(true);
            WazeWrap.Alerts.error(_SCRIPT_SHORT_NAME, 'You must select either the two <i>bracketing segments</i> or an entire detour route with <i>bracketing segments</i>.');
            return;
        }
        if (segmentSelection.multipleConnectedComponents && (segmentSelection.segments.length > 2)) {
            insertCheckBDPButton(true);
            WazeWrap.Alerts.error(
                _SCRIPT_SHORT_NAME,
                'If you select more than 2 segments, the selection of segments must be continuous.<br><br>'
            + 'Either select just the two bracketing segments or an entire detour route with bracketing segments.'
            );
            return;
        }
        if (!segmentSelection.multipleConnectedComponents && (segmentSelection.segments.length === 2)) {
            insertCheckBDPButton(true);
            WazeWrap.Alerts.error(_SCRIPT_SHORT_NAME, 'You selected only two segments and they connect to each other. There are no alternate routes.');
            return;
        }
        if (segmentSelection.segments.length === 2) {
            [startSeg, endSeg] = segmentSelection.segments;
        }
        else if (_pathEndSegId) {
            if (segmentSelection.segments[0].attributes.id === _pathEndSegId) {
                [endSeg] = segmentSelection.segments;
                startSeg = segmentSelection.segments[segmentSelection.segments.length - 1];
            }
            else {
                [startSeg] = segmentSelection.segments;
                endSeg = segmentSelection.segments[segmentSelection.segments.length - 1];
            }
            const routeNodeIds = segmentSelection.segments.slice(1, -1).flatMap((segment) => [segment.attributes.toNodeID, segment.attributes.fromNodeID]);
            if (routeNodeIds.some((nodeId) => endSeg.attributes.fromNodeID === nodeId))
                endSeg.attributes.bdpcheck = { routeFarEndNodeId: endSeg.attributes.toNodeID };
            else
                endSeg.attributes.bdpcheck = { routeFarEndNodeId: endSeg.attributes.fromNodeID };
        }
        else {
            [startSeg] = segmentSelection.segments;
            endSeg = segmentSelection.segments[segmentSelection.segments.length - 1];
            const routeNodeIds = segmentSelection.segments.slice(1, -1).flatMap((segment) => [segment.attributes.toNodeID, segment.attributes.fromNodeID]);
            if (routeNodeIds.some((nodeId) => endSeg.attributes.fromNodeID === nodeId))
                endSeg.attributes.bdpcheck = { routeFarEndNodeId: endSeg.attributes.toNodeID };
            else
                endSeg.attributes.bdpcheck = { routeFarEndNodeId: endSeg.attributes.fromNodeID };
        }
        if ((startSeg.attributes.roadType < 3) || (startSeg.attributes.roadType === 4) || (startSeg.attributes.roadType === 5) || (startSeg.attributes.roadType > 7)
        || (endSeg.attributes.roadType < 3) || (endSeg.attributes.roadType === 4) || (endSeg.attributes.roadType === 5) || (endSeg.attributes.roadType > 7)
        ) {
            insertCheckBDPButton(true);
            WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, 'At least one of the bracketing selected segments is not in the correct road type group for BDP.');
            return;
        }
        if (!rtgContinuityCheck([startSeg, endSeg])) {
            insertCheckBDPButton(true);
            WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, 'One bracketing segment is a minor highway while the other is not. BDP only applies when bracketing segments are in the same road type group.');
            return;
        }
        if (!nameContinuityCheck([startSeg, endSeg])) {
            insertCheckBDPButton(true);
            WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, 'The bracketing segments do not share a street name. BDP will not be applied to any route.');
            return;
        }
        const maxLength = (startSeg.attributes.roadType === 7) ? 5000 : 50000;
        if (segmentSelection.segments.length === 2) {
            if (((startSeg.attributes.roadType === 7) && (W.map.getZoom() > 16))
            || ((startSeg.attributes.roadType !== 7) && (W.map.getZoom() > 15))) {
                _restoreZoomLevel = W.map.getZoom();
                _restoreMapCenter = W.map.getCenter();
                await doZoom(false, (startSeg.attributes.roadType === 7) ? 16 : 15, getMidpoint(startSeg, endSeg));
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
                        maxLength, startSeg, startNode, endSeg, endNodeIds: endNodeObjs.map((nodeObj) => nodeObj?.attributes.id)
                    });
                    if (directRoutes.length > 0)
                        break;
                }
            }
        }
        else {
            const routeSegIds = W.selectionManager.getSegmentSelection().getSelectedSegments()
                    .map((segment) => segment.attributes.id)
                    .filter((segId) => (segId !== endSeg.attributes.id) && (segId !== startSeg.attributes.id)),
                endNodeObj = endSeg.getOtherNode(W.model.nodes.getObjectById(endSeg.attributes.bdpcheck.routeFarEndNodeId)),
                startSegDirection = startSeg.getDirection(),
                startNodeObjs = [],
                lastDetourSegId = routeSegIds.filter((el) => endNodeObj.attributes.segIDs.includes(el));
            let lastDetourSeg;
            if (lastDetourSegId.length === 1) {
                lastDetourSeg = W.model.segments.getObjectById(lastDetourSegId);
            }
            else {
                const oneWayTest = W.model.segments.getByIds(lastDetourSegId).filter(
                    (seg) => seg.isOneWay() && (endNodeObj.isTurnAllowedBySegDirections(endSeg, seg) || seg.isTurnAllowed(endSeg, endNodeObj))
                );
                if (oneWayTest.length === 1) {
                    [lastDetourSeg] = oneWayTest;
                }
                else {
                    insertCheckBDPButton(true);
                    WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, `Could not determine the last detour segment. Please send ${_SCRIPT_AUTHOR} a message with a PL describing this issue. Thank you!`);
                    return;
                }
            }
            const detourSegs = segmentSelection.segments.slice(1, -1),
                detourSegTypes = [...new Set(detourSegs.map((segment) => segment.attributes.roadType))];
            if ([9, 10, 16, 18, 19, 22].some((type) => detourSegTypes.indexOf(type) > -1)) {
                insertCheckBDPButton(true);
                WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, 'Your selection contains one more more segments with an unrouteable road type. The selected route is not a valid route.');
                return;
            }
            if (![1].some((type) => detourSegTypes.indexOf(type) > -1)) {
                if (((startSeg.attributes.roadType === 7) && (W.map.getZoom() > 16))
                || ((startSeg.attributes.roadType !== 7) && (W.map.getZoom() > 15))) {
                    _restoreZoomLevel = W.map.getZoom();
                    _restoreMapCenter = W.map.getCenter();
                    await doZoom(false, (startSeg.attributes.roadType === 7) ? 16 : 15, getMidpoint(startSeg, endSeg));
                }
            }
            if ((startSegDirection !== 2) && startSeg.getToNode())
                startNodeObjs.push(startSeg.getToNode());
            if ((startSegDirection !== 1) && startSeg.getFromNode())
                startNodeObjs.push(startSeg.getFromNode());
            if (nameContinuityCheck([lastDetourSeg, endSeg])) {
                insertCheckBDPButton(true);
                WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, 'BDP will not be applied to this detour route because the last detour segment and the second bracketing segment share a common street name.');
                doZoom(true, _restoreZoomLevel, _restoreMapCenter);
                return;
            }
            if (rtgContinuityCheck([lastDetourSeg, endSeg])) {
                insertCheckBDPButton(true);
                WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, 'BDP will not be applied to this detour route because the last detour segment and the second bracketing segment are in the same road type group.');
                doZoom(true, _restoreZoomLevel, _restoreMapCenter);
                return;
            }
            if (detourSegs.length < 2) {
                insertCheckBDPButton(true);
                WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, 'BDP will not be applied to this detour route because it is less than 2 segments long.');
                doZoom(true, _restoreZoomLevel, _restoreMapCenter);
                return;
            }
            if (detourSegs.map((seg) => seg.attributes.length).reduce((a, b) => a + b) > ((startSeg.attributes.roadType === 7) ? 500 : 5000)) {
                insertCheckBDPButton(true);
                WazeWrap.Alerts.info(_SCRIPT_SHORT_NAME, `BDP will not be applied to this detour route because it is longer than ${((startSeg.attributes.roadType === 7) ? '500m' : '5km')}.`);
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
        if (directRoutes.length > 0) {
            WazeWrap.Alerts.confirm(
                _SCRIPT_SHORT_NAME,
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
                () => {
                    doZoom(true, _restoreZoomLevel, _restoreMapCenter);
                    insertCheckBDPButton(true);
                },
                'Yes',
                'No'
            );
        }
        else if (segmentSelection.segments.length === 2) {
            insertCheckBDPButton(true);
            WazeWrap.Alerts.info(
                _SCRIPT_SHORT_NAME,
                'No direct routes found between the two selected segments. A BDP penalty <b>will not</b> be applied to any routes.'
                + '<br><b>Note:</b> This could also be caused by the distance between the two selected segments is longer than than the allowed distance for detours.'
            );
            doZoom(true, _restoreZoomLevel, _restoreMapCenter);
        }
        else {
            insertCheckBDPButton(true);
            WazeWrap.Alerts.info(
                _SCRIPT_SHORT_NAME,
                'No direct routes found between the possible detour bracketing segments. A BDP penalty <b>will not</b> be applied to the selected route.'
                + '<br><b>Note:</b> This could also be because any possible direct routes are very long, which would take longer to travel than taking the selected route (even with penalty).'
            );
            doZoom(true, _restoreZoomLevel, _restoreMapCenter);
        }
    }

    function insertCheckBDPButton(recreate = false) {
        const $wmeButton = $('#WME-BDPC-WME'),
            $lmButton = $('#WME-BDPC-LM'),
            $elem = $('#segment-edit-general .form-group.more-actions');
        if (recreate) {
            if ($wmeButton.length > 0)
                $wmeButton.remove();
            if ($lmButton.length > 0)
                $lmButton.remove();
        }
        if ($elem.length === 0)
            return;
        const buildElem = (id) => {
            if ($elem.find('wz-button').length > 0)
                return $('<wz-button>', { id, color: 'secondary', size: 'sm' });
            return $('<button>', { id, class: 'waze-btn waze-btn-small waze-btn-white' });
        };
        if ($('#WME-BDPC-WME').length === 0) {
            $elem.append(buildElem('WME-BDPC-WME', $elem).text('BDP Check (WME)').attr('title', 'Check BDP of selected segments, via WME.').click((e) => {
                e.preventDefault();
                doCheckBDP(false);
            }));
        }
        if ($('#WME-BDPC-LM').length === 0) {
            $elem.append(buildElem('WME-BDPC-LM', $elem).text('BDP Check (LM)').attr('title', 'Check BDP of selected segments, via LM.').click((e) => {
                e.preventDefault();
                doCheckBDP(true);
            }));
        }
    }

    function pathSelected(evt) {
        if (evt?.feature?.model?.type === 'segment')
            _pathEndSegId = evt.feature.model.attributes.id;
    }

    function checkBdpcVersion() {
        if (_IS_ALPHA_VERSION)
            return;
        try {
            const metaUrl = _IS_BETA_VERSION ? dec(_BETA_META_URL) : _PROD_META_URL;
            GM_xmlhttpRequest({
                url: metaUrl,
                onload(res) {
                    const latestVersion = res.responseText.match(/@version\s+(.*)/)[1];
                    if ((latestVersion > _SCRIPT_VERSION) && (latestVersion > (_lastVersionChecked || '0'))) {
                        _lastVersionChecked = latestVersion;
                        WazeWrap.Alerts.info(
                            _SCRIPT_LONG_NAME,
                            `<a href="${(_IS_BETA_VERSION ? dec(_BETA_URL) : _PROD_URL)}" target = "_blank">Version ${latestVersion}</a> is available.<br>Update now to get the latest features and fixes.`,
                            true,
                            false
                        );
                    }
                },
                onerror(res) {
                    // Silently fail with an error message in the console.
                    logError('Upgrade version check:', res);
                }
            });
        }
        catch (err) {
            // Silently fail with an error message in the console.
            logError('Upgrade version check:', err);
        }
    }

    async function onWazeWrapReady() {
        log('Initializing.');
        checkBdpcVersion();
        setInterval(checkBdpcVersion, 60 * 60 * 1000);
        await loadSettingsFromStorage();
        _editPanelObserver.observe(document.querySelector('#edit-panel'), {
            childList: true, attributes: false, attributeOldValue: false, characterData: false, characterDataOldValue: false, subtree: true
        });
        W.selectionManager.selectionMediator.on('map:selection:pathSelect', pathSelected);
        W.selectionManager.selectionMediator.on('map:selection:featureClick', () => { _pathEndSegId = undefined; });
        W.selectionManager.selectionMediator.on('map:selection:clickOut', () => { _pathEndSegId = undefined; });
        W.selectionManager.selectionMediator.on('map:selection:deselectKey', () => { _pathEndSegId = undefined; });
        W.selectionManager.selectionMediator.on('map:selection:featureBoxSelection', () => { _pathEndSegId = undefined; });
        showScriptInfoAlert();
        log(`Fully initialized in ${Math.round(performance.now() - _LOAD_BEGIN_TIME)} ms.`);
    }

    function onWmeReady(tries = 1) {
        if (typeof tries === 'object')
            tries = 1;
        checkTimeout({ timeout: 'onWmeReady' });
        if (WazeWrap?.Ready) {
            logDebug('WazeWrap is ready. Proceeding with initialization.');
            onWazeWrapReady();
        }
        else if (tries < 1000) {
            logDebug(`WazeWrap is not in Ready state. Retrying ${tries} of 1000.`);
            _timeouts.onWmeReady = window.setTimeout(onWmeReady, 200, ++tries);
        }
        else {
            logError('onWmeReady timed out waiting for WazeWrap Ready state.');
        }
    }

    function onWmeInitialized() {
        if (W.userscripts?.state?.isReady) {
            logDebug('W is ready and already in "wme-ready" state. Proceeding with initialization.');
            onWmeReady(1);
        }
        else {
            logDebug('W is ready, but state is not "wme-ready". Adding event listener.');
            document.addEventListener('wme-ready', onWmeReady, { once: true });
        }
    }

    function bootstrap() {
        if (!W) {
            logDebug('W is not available. Adding event listener.');
            document.addEventListener('wme-initialized', onWmeInitialized, { once: true });
        }
        else {
            onWmeInitialized();
        }
    }

    bootstrap();
}
)();
