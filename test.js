const util = require('util');
assert = require('assert');

const trips = require('vbb-trips');
const lines = require('vbb-lines');
const lines_at = require('vbb-lines-at');
const stations = require('vbb-stations/full.json');
const find = require('vbb-find-station');
const geodist = require('geodist');
const printf = require('printf');
const cloneDeep = require('lodash.clonedeep');
const process = require('process');
const FibonacciHeap = require('@tyriar/fibonacci-heap').FibonacciHeap;
const toArray = require('stream-to-array');
// server.js
// load the server resource and route GET method
const server = require('server')
const { get, socket } = require('server/router')

var all_schedules;

var linesById = {};
var scheduleArray = toArray(trips.schedules());
//var stopNames = {};
var stationByStop = {};
var nodeByStationId = {};
var currentSearches = {};

var departureTimeSpans = {
    "bus": [
        [-240, 0.00],
        [-180, 0.01],
        [-120, 0.03],
        [-60, 0.12],
        [0, 0.45],
        [60, 0.64],
        [120, 0.76],
        [180, 0.83],
        [240, 0.89],
        [300, 0.92],
        [360, 0.95],
        [420, 0.96],
        [480, 0.98],
        [540, 0.98],
        [600, 0.99],
        [660, 0.99],
        [720, 0.99],
        [780, 0.99],
        [840, 1.00]
    ],
    "subway": [
        [-120, 0.00],
        [-60, 0.04],
        [0, 0.74],
        [60, 0.91],
        [120, 0.95],
        [180, 0.98],
        [240, 0.99],
        [300, 1.00]
    ],
    "suburban":
        [
            [-60, 0.00],
            [0, 0.73],
            [60, 0.87],
            [120, 0.92],
            [180, 0.94],
            [240, 0.95],
            [300, 0.96],
            [360, 0.97],
            [420, 0.98],
            [480, 0.98],
            [540, 0.99],
            [600, 0.99],
            [660, 1.00]
        ]
};


var stopTimeSpan = [
    [0, 0],
    [1, 0.2],
    [2, 0.6],
    [10, 0.8],
    [30, 0.9],
    [80, 0.95],
    [150, 1.0]
];

/*
var travelTimeSpan = [ // for ideal travel = 60
    [ 40 , 0],
    [ 50 , 0.2],  
    [ 60 , 0.9],
    [ 75 , 0.95],
    [ 90 , 0.97],
    [150 , 1.0]
];*/

var travelTimeSpans = { // currently only for prevDelay = 0
    "bus": [
        [27, 0.00],
        [38, 0.03],
        [49, 0.14],
        [60, 0.73],
        [70, 0.91],
        [81, 0.97],
        [92, 0.99],
        [103, 0.99],
        [114, 1.00]
    ],
    "subway": [
        [40, 0.02],
        [50, 0.06],
        [60, 0.5],
        [83, 0.93],
        [106, 0.96],
        [129, 0.98],
        [176, 1.00],
    ],
    "suburban":
        [
            [45, 0.0],
            [60, 0.5],
            [75, 0.9],
            [91, 1.00]
        ]
};


var changePlatformTimeSpan = [
    [20, 0],
    [40, 0.2],
    [60, 0.8],
    [70, 0.9],
    [120, 1]
];

var transferTimeSpan = [ // for ideal travel = 60
    [40, 0],
    [50, 0.1],
    [60, 0.8],
    [70, 0.9],
    [590, 0.9],
    [600, 0.95],
    [610, 1.0]
];

var nextJourneyId = 1;

const globalResolution = 60;
const maxDataPoints = 60;
//const globalResolution = 30;
//const maxDataPoints = 120;

var map;
var mapWidth, mapHeight;
var minLng;
var maxLng;
var minLat;
var maxLat;

var schedulesByStationId = {};
var berlinStations = [];

(async () => {
    console.log("Preprocessing data");
    initBerlinStations();
    indexStops();
    initMap();


    console.log("Searching schedules");
    var subway_schedules = await getSchedulesForProduct("subway");
    var sbahn_schedules = await getSchedulesForProduct("suburban");
    all_schedules = subway_schedules.concat(sbahn_schedules);

    indexSchedules();

    startServer();
})();

/*
var exampleSearch = {
    searchId = "fo39fhjs",
    startStation: {
        id: 323,
    },
    destinationStation: {
        id: 8493,
    },
    selectedDate: new Date("2019-07-26T11:00:00"),
    time: "12:00",
    openNodes: [],
    closedNodes: [],
  };
*/

function initiateSearch(search) {
    search.openNodes = [];
    search.closedNodes = [];
    search.nodeByStationId = {};
    search.sentRoles = {};
    currentSearches[search.searchId] = search;

    // TODO use .time
    const timerange = [
        [search.startTime - globalResolution / 2, 0.0],
        [search.startTime + globalResolution / 2, 1.0],
        [search.startTime + globalResolution * 20, 1.0]
    ];
    initNodes(search);

    addOpenNode(search, search.nodeByStationId[search.initialStartStation.id], timerange, null, "losgehen");
    performSearchStep(search);
}

function performSearchStep(search) {
    if (search.openNodes.length > 0) {
        var node = search.openNodes.pop();
        processNode(search, node);
        setImmediate(() => {
            performSearchStep(search);
        })
    } else {
        sendMessage("Suche abgeschlossen");
    }
}

var globalIo;

function sendMessage(text) {
    globalIo.emit("message", text);
};

function setRole(search, stationId, role) {
    var station = stations[stationId];
    // console.log("Role " + role + " for station " + station.name);
    if(search.sentRoles[stationId] == role) { // already sen
        return;
    }
    search.sentRoles[stationId] = role;
    globalIo.emit("setrole", {
        station: {
            id: station.id,
            location: station.location,
            name: station.name,
        }, role: role
    });
};

function sendStationGraph(search, stationId, data, scheduledArrivals) {
    var array = [ ["zeit", "ankunft"] ].concat(data.map( entry => [
        new Date(entry[0] * 1000).toISOString(),
        entry[1],
        ]
    ));
    globalIo.emit("setstationgraph", {
        stationid: stationId,
        data: array,
        scheduledArrivals: scheduledArrivals,
    });
}


function sendFullGraph(search, data) {
    globalIo.emit("setgraph", {
        data: data,
    });
}

function addLine(search, points, role) {
    console.log("add a line");
    globalIo.emit("addline", { points: points, role: role });
};

function startServer() {
    // get server port from environment or default to 3000
    const port = process.env.PORT || 3000
    server({ port }, [
        get('/', ctx => '<h1>Hello you!</h1>'),
        socket('message', ctx => {
            // Send the message to every socket
            ctx.io.emit('message', ctx.data)
        }),
        socket('startSearch', ctx => {

            console.log("Shall start seach: " + util.inspect(ctx.data));
            ctx.io.emit('message', "Suche wird bald beginnen…");
            var search = {
                searchId: "search_" + ctx.id,
                initialStartStation: stations[ctx.data.startStation.id],
                finalDestinationStation: stations[ctx.data.destinationStation.id],
                startTime: new Date(ctx.data.date).getTime() / 1000,
            }

            initiateSearch(search);

            ctx.io.emit('message', "Suche hat begonnen.");
        }),
        socket('connect', ctx => {
            globalIo = ctx.io;
            console.log('client connected', Object.keys(ctx.io.sockets.sockets))
            ctx.io.emit('count', { msg: 'HI U', count: Object.keys(ctx.io.sockets.sockets).length })
        })
    ])
        .then(() => console.log(`Server running at http://localhost:${port}`))
}

function initBerlinStations() {
    var keys = Object.keys(lines_at);
    for (key of keys) {
        station = stations[key];
        var lines = lines_at[station.id].filter(line => line.product == "subway" || line.product == "suburban");
        if (lines.length > 0 && station.name.indexOf("Berlin") != -1)
            berlinStations.push(station);
    }
}

function indexSchedules() {
    for (const key in all_schedules) {
        if (all_schedules.hasOwnProperty(key)) {
            const schedule = all_schedules[key];

            const routeStopIds = schedule.route.stops;
            for (const stopId of routeStopIds) {
                var station = stationByStop[stopId];
                if (station) { // might not be found if outside of berlin
                    if (!schedulesByStationId[station.id]) {
                        schedulesByStationId[station.id] = [];
                    }
                    schedulesByStationId[station.id].push(schedule);
                }
            }
        }
    }
}

function addOpenNode(search, node, arrival, previousNode, line, prevDeparture, stops, scheduledArrivals) {
    if (node.arrivalExp) {
        assert(search.openNodes.includes(node));
        if (node.arrivalExp < getExpectedTime(arrival)) {
            return;
        } else {
            search.openNodes.splice(search.openNodes.indexOf(node), 1);
        }
    }
    sendStationGraph(search, node.station.id, arrival, scheduledArrivals);
    node.arrival = arrival;
    node.arrivalExp = getExpectedTime(arrival);
    node.heuristic = node.arrivalExp + node.distance / 42; // heuristic, meters per second, 42 m/s is about 150 km/h
    node.previousNode = previousNode;
    node.line = line;
    node.prevDeparture = prevDeparture;
    node.stops = stops;
    node.scheduledArrivals = scheduledArrivals;
    if (!search.openNodes.includes(node)) {
        search.openNodes.push(node);
    }
    search.openNodes.sort((a, b) => b.heuristic - a.heuristic);
}

function addClosedNode(search, node) {
    if (!search.closedNodes.includes(node)) {
        search.closedNodes.push(node);
    }
}

function initMap() {
    minLng = berlinStations.map(s => s.location.longitude).reduce((a, b) => Math.min(a, b)); // x
    maxLng = berlinStations.map(s => s.location.longitude).reduce((a, b) => Math.max(a, b));
    minLat = berlinStations.map(s => s.location.latitude).reduce((a, b) => Math.min(a, b)); // y
    maxLat = berlinStations.map(s => s.location.latitude).reduce((a, b) => Math.max(a, b));
    const ratio = (maxLng - minLng) / (maxLat - minLat);

    mapHeight = 90;
    mapWidth = Math.floor(mapHeight * ratio * 1.5);

    map = [];
    for (var x = 0; x <= mapWidth; x++) {
        map.push([]);
        for (var y = 0; y <= mapHeight; y++) {
            map[x].push(' ');
        }
    }

    for (const station of berlinStations) {
        drawOnMap(station.location, '.');
    }
}

function drawOnMap(location, char) {
    var x = Math.floor((location.longitude - minLng) / (maxLng - minLng) * mapWidth);
    var y = Math.floor((location.latitude - minLat) / (maxLat - minLat) * mapHeight);
    if (x < 0 || y < 0 || x >= mapWidth || y >= mapHeight)
        return;
    map[x][y] = char;
}


function drawLine(loc1, loc2, char) {
    var x1 = Math.floor((loc1.longitude - minLng) / (maxLng - minLng) * mapWidth);
    var y1 = Math.floor((loc1.latitude - minLat) / (maxLat - minLat) * mapHeight);
    var x2 = Math.floor((loc2.longitude - minLng) / (maxLng - minLng) * mapWidth);
    var y2 = Math.floor((loc2.latitude - minLat) / (maxLat - minLat) * mapHeight);

    var s = 0.5 / (Math.abs(x2 - x1) + Math.abs(y2 - y1));

    for (var a = 0; a <= 1; a += 0.01) {
        var x = Math.floor(x1 * a + x2 * (1 - a));
        var y = Math.floor(y1 * a + y2 * (1 - a));

        if (x < 0 || y < 0 || x >= mapWidth || y >= mapHeight)
            continue;
        if (map[x][y] == ' ')
            map[x][y] = char;
    }
}

function printMap(search) {
    drawOnMap(search.initialStartStation.location, '🚩');
    drawOnMap(search.finalDestinationStation.location, '🏁');

    for (var y = mapHeight - 1; y >= 0; y--) {
        var line = "";
        for (var x = 0; x <= mapWidth; x++) {
            line += map[x][y];
        }
        console.log(line);
    }
}

async function getRandomStation() {
    return berlinStations[Math.floor(Math.random() * berlinStations.length)];
}

function printTimeRange(time) {
    var timeMin = time[0][0];
    var timeMax = time[time.length - 1][0];

    const s = (timeMax - timeMin) / 20;

    for (var t = timeMin; t <= timeMax; t += s) {
        const p = interpolate(time, t);
        console.log(timestring(t) + printf(" %.4f   ", p) + "#".repeat(p * 100));
    }
}


async function getFullStationByName(name) {
    const station = await find(name);
    const full_start_station = stations[station.id];
    return full_start_station;
}


function printTimeRangeRelative(time) {
    var timeMin = time[0][0];
    var timeMax = time[time.length - 1][0];

    const s = (timeMax - timeMin) / 100;
    const s2 = s / 2;

    var maxDiff = 0;

    for (var t = timeMin; t <= timeMax; t += s) {
        const p1 = interpolate(time, t - s2);
        const p2 = interpolate(time, t + s2);
        const diff = p2 - p1;
        if (diff > maxDiff)
            maxDiff = diff;
    }

    if (maxDiff == 0) {
        console.log("Can't print this");
        return;
    }
    //          26.7.2019, 12:56:45     100.89%     100.89%     ##############
    console.log("DATE       TIME            PROB         CUMM      GRAPH");
    console.log("-------------------------------------------------------");

    for (var t = timeMin; t <= timeMax; t += s) {
        const p1 = interpolate(time, t - s2);
        const p2 = interpolate(time, t + s2);
        const diff = p2 - p1;

        var balken;
        if (diff >= 0)
            balken = "#".repeat(diff / maxDiff * 200);
        else
            balken = "NEGATIV!";
        console.log(timestring(t) + printf("     % 7.2f%%     % 7.2f%%     ", diff * 100, p2 * 100) + balken);

    }
}


function timestring(timestamp) {
    return new Date(timestamp * 1000).toLocaleString()
}


function timespanstring(timespan) {
    const median = getExpectedTime(timespan);
    var min10percent = -1;
    var max10percent = -1;

    const s = globalResolution;
    const s2 = s / 2;

    for (var t = timespan[0][0]; t <= timespan[timespan.length - 1][0]; t += s) {
        const p = interpolate(timespan, t);
        if (p > 0.1 && min10percent == -1) {
            min10percent = t;
        }
        if (p > 0.9 && max10percent == -1) {
            max10percent = t;
        }
    }

    if ((max10percent - median) < 0) {
        printTimeRangeRelative(timespan);
        console.log("WUTT?");
    }

    return new Date(median * 1000).toLocaleString() + printf(" ( -%.1f / +%.1f )", (median - min10percent) / 60, (max10percent - median) / 60);
}

function printJourney(node) {
    if (node.previousNode) {
        printJourney(node.previousNode);
        console.log("Ride with " + node.line.name + ", depart at " + timespanstring(node.prevDeparture));
    }
    if (node.stops) {
        for (var i = 0; i < node.stops.length - 1; i++) {
            var first = stationByStop[node.stops[i]];
            var second = stationByStop[node.stops[i + 1]];
            if(first && second) {
                drawLine(first.location, second.location, '🔸');
            }
        }
    }
    console.log("Start at " + node.station.name + " at " + timespanstring(node.arrival));
}


function sendJourneyRoles(search, node) {
    if (node.previousNode) {
        sendJourneyRoles(search, node.previousNode);
    }
    if (node.stops) {
        for (var i = 0; i < node.stops.length - 1; i++) {
            var first = stationByStop[node.stops[i]];
            var second = stationByStop[node.stops[i + 1]];
            if (first && i > 0 && i < node.stops.length - 1) {
                setRole(search, first.id, "through");
            }
            if(first && second) {
                addLine(search, [
                    [first.location.longitude, first.location.latitude],
                    [second.location.longitude, second.location.latitude],
                ], "route");
            }
        }
    }
    if (node.station.id != search.initialStartStation.id && node.station.id != search.finalDestinationStation.id) {
        setRole(search, node.station.id, "change");
    }
}

function sendJourneyGraphs(search, node) {
    var minTime = Infinity;
    var maxTime = 0;

    var nodes = [];
    var curNode = node;
    do {
        if (curNode.arrival[0][0] < minTime)
            minTime = curNode.arrival[0][0];
        if (curNode.arrival[curNode.arrival.length - 1][0] > maxTime)
            maxTime = curNode.arrival[curNode.arrival.length - 1][0];

        nodes.push(curNode);
        curNode = curNode.previousNode;
    } while (curNode);
    nodes.reverse();

    minTime -= 60;
    maxTime += 60;

    var s = (maxTime - minTime) / 200;

    var data = [];
    var line = [ "Zeit" ];
    for (curNode of nodes) {
        if (curNode.prevDeparture) {
            line.push("Abfahrt mit " + curNode.line.name);
        }
        line.push("Ankunft an " + curNode.station.name);
        //if (curNode.arrivalOutgoingPlatform) {
        //    line.push("Am Bahnsteig an " + curNode.station.name);
        //}
        }
    data.push(line);

    for (var t = minTime; t <= maxTime; t += s) {
        line = [ new Date(t * 1000).toISOString() ];
        for (curNode of nodes) {
            if (curNode.prevDeparture) {
                line.push(interpolate(curNode.prevDeparture, t));
            }
            line.push(interpolate(curNode.arrival, t));
            //if (curNode.arrivalOutgoingPlatform) {
            //    line.push(interpolate(curNode.arrivalOutgoingPlatform, t));
            //}
        }
        data.push(line);
    }
    sendFullGraph(search, data);
}

function printJourneyTable(node) {
    var minTime = Infinity;
    var maxTime = 0;

    var nodes = [];
    var curNode = node;
    do {
        if (curNode.arrival[0][0] < minTime)
            minTime = curNode.arrival[0][0];
        if (curNode.arrival[curNode.arrival.length - 1][0] > maxTime)
            maxTime = curNode.arrival[curNode.arrival.length - 1][0];

        nodes.push(curNode);
        curNode = curNode.previousNode;
    } while (curNode);
    nodes.reverse();

    minTime -= 60;
    maxTime += 60;

    var s = (maxTime - minTime) / 200;
    var line = "\n\nTime";
    for (curNode of nodes) {
        if (curNode.prevDeparture) {
            line += ";" + curNode.line.name;
        }
        line += ";" + curNode.station.name + " (an)";
        if (curNode.arrivalOutgoingPlatform)
            line += ";" + curNode.station.name + " (ab)";
    }
    console.log(line);

    for (var t = minTime; t <= maxTime; t += s) {
        var line = new Date(t * 1000).toLocaleTimeString('it-IT');

        for (curNode of nodes) {
            if (curNode.prevDeparture) {
                line += ";" + interpolate(curNode.prevDeparture, t);
            }
            line += ";" + interpolate(curNode.arrival, t);
            if (curNode.arrivalOutgoingPlatform)
                line += ";" + interpolate(curNode.arrivalOutgoingPlatform, t);
        }
        console.log(line.replace(/\./g, ","));
    }
}

function processNode(search, node) {
    sendMessage("Untersuche " + node.station.name);
    setRole(search, node.station.id, "active");
    if (node.station == search.finalDestinationStation) {
        console.log("Reached target.");
        printJourney(node);
        printJourneyTable(node);
        printTimeRangeRelative(node.arrival);
        sendJourneyRoles(search, node);
        sendJourneyGraphs(search, node);
        printMap(search);
        // process.exit(0);
        sendMessage("Fertig!");
        search.openNodes = [];
        return;
    }

    addClosedNode(search, node);

    const timerangeAtPlatform = makeFuzzy(node.arrival, changePlatformTimeSpan, 1);
    const minTimestamp = timerangeAtPlatform[0][0]; // earliest time that we can arrive at startStation
    const maxTimestamp = timerangeAtPlatform[timerangeAtPlatform.length - 1][0]; // latest time that we can arrive at startStation

    //if (timerangeAtPlatform[timerangeAtPlatform.length - 1][1] < 0.9) // chance that we ever arrive at the platform
    //    return;

    node.arrivalOutgoingPlatform = timerangeAtPlatform;

    var cSchedules = 0;
    var cStops = 0;
    var cDepartures = 0;
    var cMultitransfers = 0;

    for (schedule of schedulesByStationId[node.station.id]) {
        cSchedules++;
        const route_stops = schedule.route.stops;
        // we don't consider vehicles which started more than 80 minutes before our earliest arrival. The longest U-Bahn (U7) takes 56 minutes for the whole journey.
        // also we don't consider them if they start their journey more then 60 minutes after our latest possible arrival.
        const relevantStartTimes = schedule.starts.filter(ts => ts >= minTimestamp - 80 * 60 && ts <= maxTimestamp + 60 * 60);
        if (relevantStartTimes.length == 0) {
            continue;
        }


        const line = linesById[schedule.route.line];
        //onsole.log("Mode: " + util.inspect(line.product));

        var stopovers = [];

        // walk the route until we hit our current startStation
        var startStationIndex = -1;
        for (var loopStationIndex = 0; loopStationIndex < route_stops.length; loopStationIndex++) {
            cStops++;
            var destinationStation = stationByStop[route_stops[loopStationIndex]];
            if (!destinationStation) { // might be out of scope
                continue;
            }

            if (startStationIndex != -1) { // are we past startStation on this route?
                const destinationStationIndex = loopStationIndex;

                var connectingLines = lines_at[destinationStation.id];
                var destinationNode = search.nodeByStationId[destinationStation.id];
                assert(destinationNode);
                if (search.closedNodes.includes(destinationNode)) {
                    continue;
                }

                // actually, we include subways and suburban trains now. Exclude the line that we are currently on.
                var otherSuitableLines = connectingLines.filter(conline => (conline.product == "subway" || conline.product == "suburban") && conline.name != line.name);

                // how long does it usually take to drive from startStation to destinationStation?
                var minutes = (schedule.sequence[destinationStationIndex].departure - schedule.sequence[startStationIndex].departure) / 60;

                // Is it plausible to get off here? Only if we can transfer, or we are at our destination 
                if (otherSuitableLines.length > 0 || destinationStation == search.finalDestinationStation) {
                    var departures = [];
                    var scheduledArrivals = [];
                    for (const routeStartTime of relevantStartTimes) {
                        cDepartures++;
                        // scheduled time for departure from startStation
                        var scheduledDepartureTime = routeStartTime + schedule.sequence[startStationIndex].departure;

                        // rule out any departures that are too early or too late to be relevant (900 = 15 minutes)
                        if (scheduledDepartureTime < minTimestamp - 900 || scheduledDepartureTime > maxTimestamp + 900) {
                            continue;
                        }

                        // get a very exact time range, then make it fuzzy
                        const scheduledDepartureTimeRange = [[scheduledDepartureTime - 5, 0.0], [scheduledDepartureTime + 5, 1.0]];
                        const departureTime = makeFuzzy(scheduledDepartureTimeRange, departureTimeSpans[line.product], 1, 0.9);
                        departures.push(departureTime);
                        scheduledArrivals.push(new Date((scheduledDepartureTime + minutes * 60) * 1000).toISOString());
                    }

                    if (departures.length > 0) {
                        cMultitransfers++;
                        const aggregateDepartureTime = multitransfer(timerangeAtPlatform, departures);
                        if (aggregateDepartureTime.length == 0)
                            continue;
                        const steps = 1; //Math.ceil(minutes / 4);
                        var arrivalTime = aggregateDepartureTime;
                        for (var i = 0; i < steps; i++)
                            arrivalTime = makeFuzzy(arrivalTime, travelTimeSpans[line.product], minutes / steps);

                        if (!checkPlausibility(timerangeAtPlatform, aggregateDepartureTime)) console.log("^ A");
                        if (!checkPlausibility(aggregateDepartureTime, arrivalTime)) console.log("^ B");
                        setRole(search, destinationNode.station.id, "open");
                        addOpenNode(search, destinationNode, arrivalTime, node, line, aggregateDepartureTime, route_stops.slice(startStationIndex, loopStationIndex + 1), scheduledArrivals);
                    }
                }
            }
            if (destinationStation == node.station) {
                startStationIndex = loopStationIndex;
            }

        }
    }
    console.log("STARTING AT " + node.station.name);
    console.log("Schedules: " + cSchedules);
    console.log("Stops: " + cStops);
    console.log("Departures: " + cDepartures);
    console.log("Multitransfers: " + cMultitransfers);
    setRole(search, node.station.id, "closed");
}

function multitransfer(arrival, departures) {
    var combinedDeparture = [];

    const minArrivalTime = arrival[0][0];
    const maxArrivalTime = arrival[arrival.length - 1][0];

    const minDepartureTime = departures.map(d => d[0][0]).reduce((a, b) => Math.min(a, b));
    const maxDepartureTime = departures.map(d => d[d.length - 1][0]).reduce((a, b) => Math.max(a, b));

    const s = globalResolution;
    const s2 = s / 2;

    var somethingStrange = false; // set to true to trigger debug at the end
    var arrTrainNow = [];
    var pOverallSum = 0;

    for (var td = minArrivalTime; td <= maxDepartureTime; td += s) {
        // Betrachung für jeden Zeitpunkt td, zu dem ein Zug abfahren könnte

        var pSum = 0; // Wahrscheinlichkeit, dass ich jetzt abfahre

        for (var ta = minArrivalTime; ta <= td; ta += s) {
            // Betrachtung für jeden Zeitpunkt, an dem ich am Bahnsteig ankommen könnte
            var pArriveNow = interpolate(arrival, ta) - interpolate(arrival, ta - s);


            var pNoDep = 1.0; // Wahrscheinlichkeit, dass bis jetzt noch nicht abgefahren bin

            for (const departure of departures) {
                var pGoneBefore = interpolate(departure, ta);
                var pGoneNow = interpolate(departure, td);
                pNoDep *= 1 - (pGoneNow - pGoneBefore);
            }

            var pDep = 1 - pNoDep; // Wahrscheinlichkeit, dass ich bis jetzt abgefahren bin
            pSum += pDep * pArriveNow; // Gewichtete Summe über verschiedene Ankunftszeiten ta für diese eine Abfahrtszeit td
            //console.log("Ankunft " + timestring(ta) + ": " + pSum);
        }
/*
        if (pSum > interpolate(arrival, td)) {
            console.log("Hurz!");
        }
*/
        //pOverallSum += pSum; // Summe für alle bisherigen Abfahrtszeiten td
        combinedDeparture.push([td, pSum]);
        //console.log("Um " + timestring(td) + ": " + pSum);
    }

    return simplify(combinedDeparture);
}

function checkPlausibility(r1, r2) {
    const minTime = Math.min(r1[0][0], r2[0][0]);
    const maxTime = Math.max(r1[r1.length - 1][0], r2[r2.length - 1][0]);
    /*
        for (var t = minTime; t <= maxTime; t += globalResolution) {
            if (interpolate(r1, t) < interpolate(r2, t) - 0.01) {
                console.log("Inplausible at " + timestring(t) + ":");
                printTimeRange(r1);
                console.log("----");
                printTimeRange(r2);
                return false;
            }
        }
        */
    return true;
}

function oldMultitransfer(arrival, departures) {
    var combinedDeparture = [];

    const minArrivalTime = arrival[0][0];
    const maxArrivalTime = arrival[arrival.length - 1][0];

    const minDepartureTime = departures.map(d => d[0][0]).reduce((a, b) => Math.min(a, b));
    const maxDepartureTime = departures.map(d => d[d.length - 1][0]).reduce((a, b) => Math.max(a, b));

    const s = globalResolution;
    const s2 = s / 2;

    var pSum = 0;

    var somethingStrange = false; // set to true to trigger debug at the end

    var arrTrainNow = [];

    for (var t = minArrivalTime; t <= maxDepartureTime; t += s) {
        var pNoDep = 1.0; // Wahrscheinlichkeit, dass in diesem Moment kein Zug abfährt
        var pAlreadyThere = interpolate(arrival, t);

        for (const departure of departures) {
            const pt = interpolate(departure, t) - interpolate(departure, t - s); // Wahrscheinlichkeit, dass dieser Zug jetzt abfährt
            pNoDep = pNoDep * (1 - pt);
        }
        var pDep = 1 - pNoDep; // Wahrscheinlichkeit, dass in diesem Moment mindestens ein Zug losfährt

        pSum += pDep * (pAlreadyThere - pSum);
        combinedDeparture.push([t, pSum]);
        arrTrainNow.push([t, pDep]);
    }


    // combinedDeparture = simplify(combinedDeparture);

    if (somethingStrange) {
        console.log(somethingStrange);
        console.log("\n\nTime;Arrival;Train now;Combined Departure;Individual Departures;");
        for (var t = minArrivalTime; t <= maxDepartureTime; t += s) {
            var line = new Date(t * 1000).toLocaleTimeString('it-IT') + ";"
                + interpolate(arrival, t) + ";"
                + interpolate(arrTrainNow, t) + ";"
                + interpolate(combinedDeparture, t);
            for (const departure of departures) {
                line += printf(";%f", interpolate(departure, t));
            }
            console.log(line.replace(/\./g, ","));
        }

        var i = 1;
        for (const departure of departures) {
            console.log("T" + i);
            i++;
            printTimeRange(departure);
        }
        console.log("Why that?");
    }

    return combinedDeparture;
}

function simplify(timespan) {
    //console.log("Before: " + timespanstring(timespan));
    var ret = [];
    var firstSignificant = 0;
    for (var i = 1; i < timespan.length; i++) {
        if (i > 0 && timespan[i][1] > 0.005 && firstSignificant == 0) {
            timespan[i - 1][1] = 0;
            firstSignificant = i - 1;
        }
        if (timespan[i][1] > 0.995 || i == timespan.length - 1) {
            ret = timespan.slice(firstSignificant, i); // .concat( [[ timespan[i][0], 1 ]]);
            break;
        }
    }

    if (ret.length > maxDataPoints) {
        var ts = ret[0][0];
        var te = ret[ret.length - 1][0];
        var newRet = [];
        for (var i = 0; i < maxDataPoints; i++) {
            var t = ts + (te - ts) * i / maxDataPoints;
            var v = interpolate(ret, t);
            if (i == maxDataPoints - 1) {
                v = 1;
            }
            newRet.push([t, v]);
        }
        ret = newRet;
    }

    //console.log("After : " + timespanstring(ret));


    return ret;
}


function distBetweenStations(s1, s2) {
    return geodist({ lat: s1.location.latitude, lng: s1.location.longitude }, { lat: s2.location.latitude, lng: s2.location.longitude }, { unit: "meters" })
}

function getExpectedTime(timerange) {
    // TODO this is not the expected value, but some kind of median
    for (var i = 0; i < timerange.length; i++) {
        if (timerange[i][1] >= 0.9)
            return timerange[i][0];
    }
}

async function getSchedulesForProduct(product) {
    var product_lines = await lines(true, { product: product });
    for (const key in product_lines) {
        if (product_lines.hasOwnProperty(key)) {
            const line = product_lines[key];
            linesById[line.id] = line;
        }
    }

    const line_ids = product_lines.map(line => line.id);
    const schedules = await scheduleArray;
    const product_schedules = schedules.filter(schedule => line_ids.indexOf(schedule.route.line) != -1);
    console.log("Found " + product_schedules.length + " " + product + " schedules.");

    return product_schedules;
}

function indexStops() {
    for (station of berlinStations) {
        for (const stopKey in station.stops) {
            if (station.stops.hasOwnProperty(stopKey)) {
                const stop = station.stops[stopKey];
                stationByStop[stop.id] = station;
            }
        }
    }
}

function initNodes(search) {
    for (station of berlinStations) {
        search.nodeByStationId[station.id] = {
            station: station,
            arrival: null,
            arrivalExp: null,
            distance: distBetweenStations(station, search.finalDestinationStation),
            heuristic: null,
            journey: null
        };
    }
}

function getStopName(stopId) {
    if (!stopNames.hasOwnProperty(stopId)) {
        stopNames[stopId] = stationByStop[stopId].name || "not found";
    }
    return stopNames[stopId];
}

function interpolate(map, t) {
    //assert(map[0][1] == 0.0);
    //assert(map[map.length - 1][1] == 1.0);

    for (var i = 0; i < map.length; i++) {
        if (map[i][0] > t) {
            if (i == 0) {
                return map[0][1];
            } else {
                const t0 = map[i - 1][0];
                const t1 = map[i][0];
                const v0 = map[i - 1][1];
                const v1 = map[i][1];
                const alpha = (t - t0) / (t1 - t0);
                return v0 * (1 - alpha) + v1 * alpha;
            }
        }
    }
    return map[map.length - 1][1];
}

function makeFuzzy(start, duration, timeMultiplier, pMultiplier = 1) {
    var ret = [];

    var startMin = start[0][0];
    var startMax = start[start.length - 1][0];
    var durationMin = duration[0][0];
    var durationMax = duration[duration.length - 1][0];
    var realDurationMin = durationMin * timeMultiplier;
    var realDurationMax = durationMax * timeMultiplier;

    var ret = [];

    const s = globalResolution;
    const s2 = s / 2;

    for (var t = startMin + realDurationMin - s; t <= startMax + realDurationMax + s; t += s) {
        ret.push([t, 0]);
    }

    for (var tStart = startMin; tStart <= startMax; tStart += s) {
        for (var tDuration = durationMin; tDuration <= durationMax; tDuration += s) {
            t = tStart + tDuration * timeMultiplier;
            const pStart = interpolate(start, tStart - s2) - interpolate(start, tStart + s2);
            const pDuration = interpolate(duration, tDuration - s2) - interpolate(duration, tDuration + s2);
            const p = pStart * pDuration;
            for (const pair of ret) {
                if (pair[0] >= t) {
                    pair[1] += p * pMultiplier;
                    break;
                }
            }
        }
    }

    for (var i = 1; i < ret.length; i++) {
        ret[i][1] += ret[i - 1][1];
    }

    return simplify(ret);
}