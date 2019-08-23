const util = require('util');
assert = require('assert');

const trips = require('vbb-trips');
const lines = require('vbb-lines');
const lines_at = require('vbb-lines-at');
const stations = require('vbb-stations/full.json');
const find = require('vbb-find-station');
const geodist = require('geodist');
const printf = require('printf');

const FibonacciHeap = require('@tyriar/fibonacci-heap').FibonacciHeap;

var toArray = require('stream-to-array');

var subway_schedules;
var sbahn_schedules;
var all_schedules;
var linesById = {};
var sbahn_schedules;
var scheduleArray = toArray(trips.schedules());
var stopNames = {};
var stationByStop = {};

var startStation;
var destStation;

var bestEta;

const all_stations = stations;

const heap = new FibonacciHeap();


var stopTime = [
    [-20 , 0],
    [-10 , 0.2],  
    [  0 , 0.6],
    [ 10 , 0.8],
    [ 30 , 0.9],
    [ 80 , 0.95],
    [150 , 1.0]
];

var travelTime = [ // for ideal travel = 60
    [ 40 , 0],
    [ 50 , 0.2],  
    [ 60 , 0.9],
    [ 75 , 0.95],
    [ 90 , 0.97],
    [150 , 1.0]
];
   

var transferTime = [ // for ideal travel = 60
    [ 40 , 0],
    [ 50 , 0.1],
    [ 60 , 0.8],  
    [ 70 , 0.9],
    [590 , 0.9],
    [600 , 0.95],
    [610 , 1.0]
];

(async () => {
    testDrive();

    console.log("Preprocessing data");
    indexStops();

    console.log("Searching schedules");
    subway_schedules = await getSchedulesForProduct("subway");
    sbahn_schedules = await getSchedulesForProduct("suburban");
    all_schedules = subway_schedules.concat(sbahn_schedules);

    startStation = await getFullStationByName("Altstadt Spandau, Berlin");
    destStation = await getFullStationByName("Nollendorfplatz, Berlin");

    const startTime = new Date("2019-07-26T12:24:00").getTime() / 1000;
    const timerange = [ [startTime, 1.0] ];
    addTask(timerange, startStation, []);

    console.log("Starting search");
    

    while (!heap.isEmpty()) {
        const node = heap.extractMinimum();
        await processTask(node.value);
    }
})();

function testDrive() {
    const startTime = new Date("2019-07-26T12:24:00").getTime() / 1000;
    var timerange = [ [startTime - 5, 0], [startTime, 0.5], [startTime + 5, 1.0],  ];

    console.log("Starting test drive");
    printTimeRangeRelative(timerange);

    const distances = [1, 2, 2, 1, 3, 5, 2, 1.5, 2.5, 1, 1, 4];

    for(var i = 0; i < 12; i++) {
        console.log("\nTraveled about " + distances[i] + " minutes.");
        timerange = travel(timerange, travelTime, distances[i]);
        timerange = travel(timerange, stopTime, 1);
        printTimeRangeRelative(timerange);

        if(i % 4 == 0) {
            console.log("\nTrasfer!");
            timerange = travel(timerange, transferTime, 1);
            printTimeRangeRelative(timerange);
        }
    }
}

function printTimeRange(time) {
    var timeMin = time[0][0];
    var timeMax = time[time.length - 1][0];

    const s = (timeMax - timeMin) / 20;

    for(var t = timeMin; t <= timeMax; t += s) {
        const p = interpolate(time, t);
        console.log(timestring(t) + printf(" %.4f   ",p) + "#".repeat(p * 100));
    }
}


function printTimeRangeRelative(time) {
    var timeMin = time[0][0];
    var timeMax = time[time.length - 1][0];

    const s = (timeMax - timeMin) / 30;
    const s2 = s / 2;

    var maxDiff = 0;

    for(var t = timeMin; t <= timeMax; t += s) {
        const p1 = interpolate(time, t - s2);
        const p2 = interpolate(time, t + s2);
        const diff = p2 - p1;
        if(diff > maxDiff)
            maxDiff = diff;
    }

    for(var t = timeMin; t <= timeMax; t += s) {
        const p1 = interpolate(time, t - s2);
        const p2 = interpolate(time, t + s2);
        const diff = p2 - p1;

        console.log(timestring(t) + printf(" %.4f   ",diff) + "#".repeat(diff / maxDiff * 200));
    }
}


function timestring(timestamp) {
    return  new Date(timestamp * 1000).toLocaleString()
}

async function processTask(task) {
    if(!bestEta || task.estimatedWalkArrival < bestEta) {
        bestEta = task.estimatedWalkArrival;
        //console.log("(" + heap.size() + ") Starting from " + task.start.name + " at around " + timestring(getExpectedTime(task.timerange)) + ", etwa "+task.distance+"m Fußweg verbleiben, ETA: " + timestring(task.estimatedWalkArrival) + " (zuvor: " + task.history.join(" - ")  +")");
    
    }

    if(!bestEta || task.estimatedWalkArrival < bestEta + 300) {
        console.log("(" + heap.size() + ") Starting from " + task.start.name + " at around " + timestring(getExpectedTime(task.timerange)) + ", etwa "+task.distance+"m Fußweg verbleiben, ETA: " + timestring(task.estimatedWalkArrival) + " (zuvor: " + task.history.join(" - ")  +")");
    }
  
    
    const minTimestamp = task.timerange[0][0];
    const maxTimestamp = task.timerange[task.timerange.length - 1][0] + 60 * 10;

    const start_stop_ids = task.start.stops.map( stop => stop.id);

    for (const key in all_schedules) {
        if (all_schedules.hasOwnProperty(key)) {
            const schedule = all_schedules[key];
            
            const route_stops = schedule.route.stops;
            const intersection = route_stops.filter(id => start_stop_ids.indexOf(id) > -1);

            if(intersection.length > 0) {
                const common_stop_id = intersection[0];
                const relevantSchedules = schedule.starts.filter(ts => ts >= minTimestamp - 60 * 60 && ts <= maxTimestamp);
                const line = linesById[schedule.route.line];
                for (const startTime of relevantSchedules) {
                    const lastStopId = route_stops[route_stops.length - 1];
                    //console.log(line.name + " nach " + getStopName(lastStopId) + "("+ route_stops.length + " Halte)");

                    var currentStationIndex = -1;
                    for(var i = 0; i < route_stops.length; i++) {
                        var station = stationByStop[route_stops[i]];
 
                        if(currentStationIndex != -1) {
                            var connectingLines = lines_at[station.id];
                            var otherSubways = connectingLines.filter(conline => (conline.product == "subway" || conline.product == "suburban") && conline.name != line.name);
                            if(otherSubways.length > 0 || station == destStation || distBetweenStations(station, destStation) < 1400) {
                                var linesString = otherSubways.map(line => line.name).join(", ");
                                var minutes = (schedule.sequence[i].departure - schedule.sequence[currentStationIndex].departure) / 60;
                                var absTime = startTime + schedule.sequence[i].departure;
                                //console.log("   " + timestring(absTime) + ": " + station.name + " ("+linesString+")");
                                var desc = line.name + " von " + task.start.name + " nach " + station.name;
                                const timerange = [ [absTime + 90, 1.0] ];
                                addTask(timerange, station, task.history.concat([desc]));
                            }
                        }
                        if(station == task.start) {
                            currentStationIndex = i;
                            var absTime = startTime + schedule.sequence[i].departure;
                            if(absTime < minTimestamp || absTime > maxTimestamp) {
                                break;
                            }
                        }
  
                    }
                    //console.log(relevantSchedules.map( timestamp => new Date(timestamp * 1000).toLocaleString() ));
                }
            }
        }
    }
}

function distBetweenStations(s1, s2) {
    return geodist( {lat: s1.location.latitude , lng: s1.location.longitude }, {lat: s2.location.latitude , lng: s2.location.longitude }, {unit:"meters"})
}

function addTask(timerange, station, history) {
    const distance = distBetweenStations(station, destStation);
    const walkSeconds = distance;
    const driveSeconds = distance / 3;
    const estimatedWalkArrival = getExpectedTime(timerange) + walkSeconds;
    const estimatedDriveArrival = getExpectedTime(timerange) + driveSeconds;
    const task = {
        start : station,
        timerange : timerange,
        history: history,
        distance: distance,
        estimatedWalkArrival : estimatedWalkArrival
    };
    heap.insert(estimatedDriveArrival, task);
}

function getExpectedTime(timerange) {
    // TODO this is not the expected value, but some kind of median
    for(var i = 0; i < timerange.length; i++) {
        if(timerange[i][1] >= 0.5)
            return timerange[i][0];
    }
}


async function getFullStationByName(name) {
    const station = await find(name);
    const full_start_station = stations[station.id];
    return  full_start_station;
}

async function getStopsFromStationName(name) {
    const station = await find(name);
    const full_start_station = stations[station.id];
    return  full_start_station.stops.map( stop => stop.id);
}

async function getSchedulesForProduct(product) {
    var product_lines = await lines(true, {product:product});
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
    for (const key in all_stations) {
        if (all_stations.hasOwnProperty(key)) {
            const station = all_stations[key];
            for (const stopKey in station.stops) {
                if (station.stops.hasOwnProperty(stopKey)) {
                    const stop = station.stops[stopKey];
                    stationByStop[stop.id] = station;
                }
            }
        }
    }
    
}

function getStopName(stopId) {
    if(!stopNames.hasOwnProperty(stopId)) {
        stopNames[stopId] = stationByStop[stopId].name || "not found";
    }
    return stopNames[stopId];
}

function transfer(arrival, departure, transferTime) {
    var ret = [];

    var ts = Math.min(arrival[0][0], departure[0][0]);
    var te = Math.max(arrival[arrival.length - 1][0], departure[departure.length - 1][0]);

    var p_sum = 0;

    for(var t = ts; t <= te; t += 10) {
        const pa = interpolate(arrival, t-transferTime);   // Wahrscheinlichkeit, dass man bis jetzt angekommen ist
        const pd = interpolate(departure, t); // Wahrscheinlichkeit, dass der Anschluss bis jetzt schon abgefahren ist
        //console.log("t" + t + ": " + interpolate(arrival, t)  + " / " + interpolate(departure, t));
        const p = pa * (1-pd) * (1 - p_sum); // Wahrscheinlichkeit, dass man jetzt losfährt 
        p_sum += p; // Wahrscheinlichkeit, dass man bis jetzt irgendwie weggefahren ist
        ret.push([t, p]);
    }

    console.log("Wahrscheinlichkeit, den Anschluss nicht zu bekommen: " + (1-p_sum));

    return ret;
}

function interpolate(map, t) {
    assert(map[0][1] == 0.0);
    assert(map[map.length - 1][1] == 1.0);
    
    for(var i = 0; i < map.length; i++) {
        if(map[i][0] > t) {
            if(i == 0) {
                return map[0][1];
            } else {
                const t0 = map[i - 1][0];
                const t1 = map[i    ][0]; 
                const v0 = map[i - 1][1];
                const v1 = map[i    ][1];
                const alpha = (t - t0) / (t1 - t0);
                return v0 * (1 - alpha) + v1 * alpha;
            }
        }
    }
    return map[map.length - 1][1];
}

function travel(start, duration, multiplier) {
    var ret = [];

    var startMin = start[0][0];
    var startMax = start[start.length - 1][0];
    var durationMin = duration[0][0];
    var durationMax = duration[duration.length - 1][0];
    var realDurationMin = durationMin * multiplier;
    var realDurationMax = durationMax * multiplier;

    var ret = [];

    const s = 10;
    console.log("Stepsize " + s);
    const s2 = s / 2;

    for(var t = startMin + realDurationMin - s; t <= startMax + realDurationMax + s; t += s) {
        ret.push([t,0]);
    }

    for(var tStart = startMin; tStart <= startMax; tStart += s) {
        for(var tDuration = durationMin; tDuration <= durationMax; tDuration += s) {
            t = tStart + tDuration * multiplier;
            const pStart    = interpolate(start, tStart - s2) - interpolate(start, tStart + s2);  
            const pDuration = interpolate(duration, tDuration - s2) - interpolate(duration, tDuration  + s2);
            const p = pStart * pDuration;
            for (const pair of ret) {
                if(pair[0] >= t) {
                    pair[1] += p;
                    break;
                }
            }
        }
    }

    var firstSignificant = 0;
    for(var i = 1; i < ret.length; i++) {
        ret[i][1] += ret[i-1][1];
        if(i > 0 && ret[i][1] > 0.002 && firstSignificant == 0) {
            ret[i - 1][1] = 0;
            firstSignificant = i - 1;
        }
        if(ret[i][1] > 0.998) {
            return ret.slice(firstSignificant, i).concat( [[ ret[i][0], 1 ]]);
        }
    }

    return ret;
}