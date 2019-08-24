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

var toArray = require('stream-to-array');

var subway_schedules;
var sbahn_schedules;
var all_schedules;
var linesById = {};
var sbahn_schedules;
var scheduleArray = toArray(trips.schedules());
var stopNames = {};
var stationByStop = {};

var initialStartStation;
var finalDestionationStation;
var startTime;

var bestEta;

const all_stations = stations;

var heap = new FibonacciHeap();

/*
var departureTimeSpan = [
    [ -60 , 0],  
    [ -30 , 0.15],
    [   0 , 0.6],
    [  30 , 0.8],
    [  60 , 0.85],
    [ 120 , 1]
];
*/

var departureTimeSpan = [
    [-120 , 0],
    [ -60 , 0.05],  
    [ -30 , 0.15],
    [   0 , 0.6],
    [  30 , 0.8],
    [  60 , 0.85],
    [ 120 , 0.90],
    [ 180 , 0.92],
    [ 300 , 0.95],
    [ 600 , 0.98],
    [1200 , 1.0]
];


var stopTimeSpan = [
    [-20 , 0],
    [-10 , 0.2],  
    [  0 , 0.6],
    [ 10 , 0.8],
    [ 30 , 0.9],
    [ 80 , 0.95],
    [150 , 1.0]
];

var travelTimeSpan = [ // for ideal travel = 60
    [ 40 , 0],
    [ 50 , 0.2],  
    [ 60 , 0.9],
    [ 75 , 0.95],
    [ 90 , 0.97],
    [150 , 1.0]
];
   

var changePlatformTimeSpan = [
    [ 20 , 0],
    [ 40 , 0.2],
    [ 60 , 0.8],  
    [ 70 , 0.9],
    [120 , 1]
];

var transferTimeSpan = [ // for ideal travel = 60
    [ 40 , 0],
    [ 50 , 0.1],
    [ 60 , 0.8],  
    [ 70 , 0.9],
    [590 , 0.9],
    [600 , 0.95],
    [610 , 1.0]
];

var nextJourneyId = 1;

const globalResolution = 30;
const maxDataPoints = 100;

(async () => {
    // testDrive();

    console.log("Preprocessing data");
    indexStops();

    console.log("Searching schedules");
    subway_schedules = await getSchedulesForProduct("subway");
    sbahn_schedules = await getSchedulesForProduct("suburban");
    all_schedules = subway_schedules.concat(sbahn_schedules);

    initialStartStation = await getFullStationByName("Dahlem Dorf, Berlin");
    finalDestionationStation = await getFullStationByName("Schönhauser Allee, Berlin");

    initialStartStation = await getRandomStation();
    finalDestionationStation = await getRandomStation();

    startTime = new Date("2019-07-26T23:24:00").getTime() / 1000 + (Math.random() * 7 * 24 * 60 * 60);
    const timerange = [ [startTime - globalResolution / 2, 0.0], [startTime + globalResolution / 2, 1.0] ];
    var journey = {
        type: 'journey',
        id: nextJourneyId++,
        legs: [
            
        ]
    };

    addTask(timerange, initialStartStation, journey);

    console.log("Starting search from " + initialStartStation.name + " to " + finalDestionationStation.name + " at " + timestring(startTime));
    

    while (!heap.isEmpty()) {
        var newHeap = new FibonacciHeap();
        while (!heap.isEmpty()) {
            const node = heap.extractMinimum();
            console.log("ETA " + timestring(node.key) + " Start " + timespanstring(node.value.timerange) + " " + node.value.distance + "m "+ node.value.start.name);
            newHeap.insert(node.key, node.value);
            if(newHeap.size() > 20)
                break;
        }

        heap = newHeap;

        const node = heap.extractMinimum();
        await processTask(node.value);
    }
})();

async function getRandomStation() {
    var station;
    var keys = Object.keys(lines_at);
    do {
        var stationId = keys[Math.floor(Math.random() * keys.length)];
        station = all_stations[stationId];
        var lines = lines_at[station.id].filter(line => line.product == "subway" || line.product == "suburban");
        if(station.name.indexOf("Berlin") == -1)
            lines = [];
    } while(lines.length == 0);
    return station;
}

function testDrive() {
    const startTime = new Date("2019-07-26T12:24:00").getTime() / 1000;
    var timerange = [ [startTime - 5, 0], [startTime, 0.5], [startTime + 5, 1.0],  ];

    console.log("Starting test drive");
    printTimeRangeRelative(timerange);

    const distances = [1, 2, 2, 1, 3, 5, 2, 1.5, 2.5, 1, 1, 4];

    for(var i = 0; i < 12; i++) {
        console.log("\nTraveled about " + distances[i] + " minutes.");
        timerange = travel(timerange, travelTimeSpan, distances[i]);
        timerange = travel(timerange, stopTimeSpan, 1);
        printTimeRangeRelative(timerange);

        if(i % 4 == 0) {
            console.log("\nTrasfer!");
            timerange = travel(timerange, transferTimeSpan, 1);
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

    const s = (timeMax - timeMin) / 100;
    const s2 = s / 2;

    var maxDiff = 0;

    for(var t = timeMin; t <= timeMax; t += s) {
        const p1 = interpolate(time, t - s2);
        const p2 = interpolate(time, t + s2);
        const diff = p2 - p1;
        if(diff > maxDiff)
            maxDiff = diff;
    }
     //          26.7.2019, 12:56:45     100.89%     100.89%     ##############
    console.log("DATE       TIME            PROB         CUMM      GRAPH");
    console.log("-------------------------------------------------------");

    for(var t = timeMin; t <= timeMax; t += s) {
        const p1 = interpolate(time, t - s2);
        const p2 = interpolate(time, t + s2);
        const diff = p2 - p1;

        console.log(timestring(t) + printf("     % 7.2f%%     % 7.2f%%     ",diff * 100, p2 * 100) + "#".repeat(diff / maxDiff * 200));
    }
}


function timestring(timestamp) {
    return  new Date(timestamp * 1000).toLocaleString()
}


function timespanstring(timespan) {
    const median = getExpectedTime(timespan);
    var min10percent = -1;
    var max10percent = -1;

    const s = globalResolution;
    const s2 = s / 2;

    for(var t = timespan[0][0]; t <= timespan[timespan.length - 1][0]; t += s) {
        const p = interpolate(timespan, t);
        if(p > 0.1 && min10percent == -1) {
            min10percent = t;
        }
        if(p > 0.9 && max10percent == -1) {
            max10percent = t;
        }
    }

    return  new Date(median * 1000).toLocaleString() + printf(" ( -%.1f / +%.1f )", (median - min10percent) / 60, (max10percent - median) / 60);
}

async function processTask(task) {
    const startStation = task.start;

    if(!bestEta || task.estimatedWalkArrival < bestEta + 300) {
        console.log("(" + heap.size() + ") Starting from " + startStation.name + " at around " + timespanstring(task.timerange) + ", etwa "+task.distance+"m Fußweg verbleiben, ETA: " + timestring(task.estimatedWalkArrival) + " (zuvor: " + task.journey.legs.length +")");
    }

    if(!bestEta || task.estimatedWalkArrival < bestEta) {
        bestEta = task.estimatedWalkArrival;
        console.log("NEW BEST JOURNEY:");

        console.log("(" + heap.size() + ") Starting from " + startStation.name + " at around " + timespanstring(task.timerange) + ", etwa "+task.distance+"m Fußweg verbleiben, ETA: " + timestring(task.estimatedWalkArrival) + " (zuvor: " + task.journey.legs.length +")");
        if(task.distance == 0) {
            console.log(util.inspect(task.journey, { depth: null}));

            console.log("\n\nFound journey from " + initialStartStation.name + " to " + finalDestionationStation.name + ", starting at " + timestring(startTime));
    

            for(leg of task.journey.legs) {
                console.log("\nRide with " + leg.scheduleName);
                console.log("\nArrival at " + leg.destinationName);
                printTimeRangeRelative(leg.arrivalTimeSpan);
            }
            //process.exit(0);
        }
    }
    
    
    const timerangeAtPlatform = travel(task.timerange, changePlatformTimeSpan, 1);
    
    //console.log("(" + heap.size() + ") Starting from " + startStation.name + " at " + timespanstring(timerangeAtPlatform) + ", about "+task.distance+"m walk, ETA: " + timestring(task.estimatedWalkArrival) + " (zuvor: " + task.history.join(" - ")  +")");

    const minTimestamp = timerangeAtPlatform[0][0]; // earliest time that we can arrive at startStation
    const maxTimestamp = timerangeAtPlatform[timerangeAtPlatform.length - 1][0]; // latest time that we can arrive at startStation

    const start_stop_ids = startStation.stops.map( stop => stop.id);

    for (const key in all_schedules) {
        if (all_schedules.hasOwnProperty(key)) {
            const schedule = all_schedules[key];
            
            const route_stops = schedule.route.stops;
            const intersection = route_stops.filter(id => start_stop_ids.indexOf(id) > -1);

            if(intersection.length > 0) { // does this route have a stop at our current startStation station?
                // first step of time filtering: only get trans which started their route within the last hour
                const relevantSchedules = schedule.starts.filter(ts => ts >= minTimestamp - 80 * 60 && ts <= maxTimestamp + 20 * 60);
                const line = linesById[schedule.route.line];
                
                //const lastStopId = route_stops[route_stops.length - 1];
                //console.log(line.name + " nach " + getStopName(lastStopId) + "("+ route_stops.length + " Halte)");

                var stopovers = [];

                // walk the route until we hit our current startStation
                var startStationIndex = -1;
                for(var loopStationIndex = 0; loopStationIndex < route_stops.length; loopStationIndex++) {
                    var station = stationByStop[route_stops[loopStationIndex]];

                    if(startStationIndex != -1) { // are we past startStation on this route?
                        if(loopStationIndex > startStationIndex + 4) { // THIS IS GONNA BE FUN!
                          //  break;
                        }

                        const destinationStationIndex = loopStationIndex;
                        const destinationStation = station;

                        var connectingLines = lines_at[destinationStation.id];

                        // actually, we include subways and suburban trains now. Exclude the line that we are currently on.
                        var otherSubways = connectingLines.filter(conline => (conline.product == "subway" || conline.product == "suburban") && conline.name != line.name);

                        // how long does it usually take to drive from startStation to destinationStation?
                        var minutes = (schedule.sequence[destinationStationIndex].departure - schedule.sequence[startStationIndex].departure) / 60;

                        // Is it plausible to get off here? Only if we can transfer, we are at our destination, or close enough to try walking from here
                        if(otherSubways.length > 0 || destinationStation == finalDestionationStation || distBetweenStations(destinationStation, finalDestionationStation) < 1400) {
                            var linesString = otherSubways.map(line => line.name).join(", ");

                            
                            //var printedHeader = false;
                            var departures = [];
                            for (const routeStartTime of relevantSchedules) {
                                // scheduled time for departure from startStation
                                var scheduledDepartureTime = routeStartTime + schedule.sequence[startStationIndex].departure;
                                
                                
                                // rule out any departures that are too early or too late to be relevant
                                if(scheduledDepartureTime < minTimestamp - 180 || scheduledDepartureTime > maxTimestamp + 1200) {
                                    continue;
                                }

                                // get a very exact time range
                                const scheduledDepartureTimeRange = [ [scheduledDepartureTime - 5, 0.0], [scheduledDepartureTime + 5, 1.0] ];
                                // then make it fuzzy
                                const departureTime = travel(scheduledDepartureTimeRange, departureTimeSpan, 1);
                                departures.push(departureTime);
                            }

                            if(departures.length > 0)
                            {
                                //console.log("   " + departures.length + " departures for train " + line.name + ", " + minutes + " minutes to " + destinationStation.name + (linesString.length > 0 ? (" (transfer to "+linesString+")") : ""));
                                
                                var desc = line.name + " von " + startStation.name + " nach " + destinationStation.name;
                                
                                const aggregateDepartureTime = multitransfer(timerangeAtPlatform, departures);
                                const arrivalTime = travel(aggregateDepartureTime, travelTimeSpan, minutes);

                                assert(arrivalTime.length < maxDataPoints + 1);
                                //console.log("        Departue at " + timespanstring(aggregateDepartureTime));
                                //printTimeRangeRelative(aggregateDepartureTime);
                                //console.log("        Arrival  at " + timespanstring(arrivalTime));
                                //printTimeRangeRelative(arrivalTime);

                                var simpleDepartureTime = getExpectedTime(aggregateDepartureTime);

                                var newJourney = cloneDeep(task.journey);
                                newJourney.id = nextJourneyId++;

                                var newStopovers = cloneDeep(stopovers);
                                for (const stopover of stopovers) {
                                    stopover.departure = new Date((simpleDepartureTime + stopover.minutes * 60)*1000).toISOString();
                                }

                                newJourney.legs.push({
                                    // - station/stop/location id or object
                                    // - required
                                    origin: startStation.id,

                                    originName: startStation.name,

                                    // station/stop/location id or object
                                    // - required
                                    destination: destinationStation.id,

                                    destinationName: destinationStation.name,

                                    // - ISO 8601 string (with origin timezone)
                                    // - required
                                    departure: new Date(simpleDepartureTime * 1000).toISOString(),

                                    departureTimeSpan: aggregateDepartureTime,

                                    // - ISO 8601 string (with destination timezone)
                                    // - required
                                    arrival: new Date(getExpectedTime(arrivalTime)*1000).toISOString(),

                                    arrivalTimeSpan: arrivalTime,

                                    // - array of stopover objects
                                    // - optional
                                    stopovers: newStopovers,

                                    // - schedule id or object
                                    // - optional
                                    schedule: schedule.id,

                                    scheduleName: linesById[schedule.route.line].name + " [heading to " + getStopName(schedule.route.stops[schedule.route.stops.length - 1]) + "]",

                                    public: true, // is it publicly accessible?
                                });

                                addTask(arrivalTime, destinationStation, newJourney);
                            }
                        }
                        stopovers.push({
                            type: 'stopover', // required

                            // - stop/station id or object
                            // - required
                            stop: station.id,

                            minutes: minutes
                        });
                    }
                    if(station == startStation) {
                        startStationIndex = loopStationIndex;
                    }
                }
            }
        }
    }
}

function multitransfer(arrival, departures) {
    var combinedDeparture = [];

    const minArrivalTime = arrival[0][0];
    const maxArrivalTime = arrival[arrival.length-1][0];

    const minDepartureTime = departures[0][0][0];
    const lastDeparture = departures[departures.length - 1];
    const maxDepartureTime = lastDeparture[lastDeparture.length-1][0];

    const s = globalResolution;
    const s2 = s / 2;

    var pStillThere = 1;

    for(var t = minDepartureTime; t <= maxDepartureTime; t += s) {
        combinedDeparture.push( [t, 0] );
    }

    for(var ta = minArrivalTime; ta <= maxArrivalTime; ta += s) {
        const pArrival = interpolate(arrival, ta + s2) - interpolate(arrival, ta - s2); // Wahrscheinlichkeit, dass ich in diesem Zeitpunkt ankomme
        
       // vorausgesetzt, ich bin seit genau $ta da
        
        for(var t = ta; t <= maxDepartureTime; t += s) {
            var pStillThere = 1;
            for (const departure of departures) {     
                const pd = interpolate(departure, t) - interpolate(departure, ta); // Wahrscheinlichkeit, dass dieser Zug zwischen ta und t abgefahren ist
                pStillThere = pStillThere * (1 - pd);
            }

            //console.log("Still there at " + timestring(t) + " with p = " + pStillThere);
           
            for(var i = 0; i < combinedDeparture.length; i++) {
                if(combinedDeparture[i][0] >= t) {
                    combinedDeparture[i][1] += pArrival * (1 - pStillThere);
                    break;
                }
            }
        }
    }
   
    combinedDeparture = simplify(combinedDeparture);
    return combinedDeparture;
}

function simplify(timespan) {
    var firstSignificant = 0;
    for(var i = 1; i < timespan.length; i++) {
        if(i > 0 && timespan[i][1] > 0.005 && firstSignificant == 0) {
            timespan[i - 1][1] = 0;
            firstSignificant = i - 1;
        }
        if(timespan[i][1] > 0.995 || i == timespan.length - 1) {
            ret = timespan.slice(firstSignificant, i).concat( [[ timespan[i][0], 1 ]]);
            break;
        }
    }

    if(ret.length > maxDataPoints) {
        var ts = ret[0][0];
        var te = ret[ret.length - 1][0];
        var newRet = [];
        for(var i = 0; i < maxDataPoints; i++) {
            var t = ts + (te - ts) * i / maxDataPoints;
            var v = interpolate(ret, t);
            if(i == maxDataPoints - 1) {
                v = 1;
            }
            newRet.push( [t, v] );
        }
        ret = newRet;
    }

    return ret;
}


function distBetweenStations(s1, s2) {
    return geodist( {lat: s1.location.latitude , lng: s1.location.longitude }, {lat: s2.location.latitude , lng: s2.location.longitude }, {unit:"meters"})
}

function addTask(timerange, station, journey) {
    const distance = distBetweenStations(station, finalDestionationStation);
    const walkSeconds = distance;
    const driveSeconds = distance / 9;
    const estimatedWalkArrival = getExpectedTime(timerange) + walkSeconds;
    const estimatedDriveArrival = getExpectedTime(timerange) + driveSeconds;
    const task = {
        start : station,
        timerange : timerange,
        journey: journey,
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

    for(var t = ts; t <= te; t += globalResolution) {
        const pa = interpolate(arrival, t-transferTime);   // Wahrscheinlichkeit, dass man bis jetzt angekommen ist
        const pd = interpolate(departure, t); // Wahrscheinlichkeit, dass der Anschluss bis jetzt schon abgefahren ist
        //console.log("t" + t + ": " + interpolate(arrival, t)  + " / " + interpolate(departure, t));
        const p = pa * (1-pd) * (1 - p_sum); // Wahrscheinlichkeit, dass man jetzt losfährt 
        p_sum += p; // Wahrscheinlichkeit, dass man bis jetzt irgendwie weggefahren ist
        ret.push([t, p]);
    }

    var firstSignificant = 0;
    for(var i = 1; i < ret.length; i++) {
        ret[i][1] += ret[i-1][1];
        if(i > 0 && ret[i][1] > 0.002 && firstSignificant == 0) {
            ret[i - 1][1] = 0;
            firstSignificant = i - 1;
        }
        if(ret[i][1] > 0.99 || i == ret.length - 1) {
            ret = ret.slice(firstSignificant, i).concat( [[ ret[i][0], 1 ]]);
            break;
        }
    }

    console.log("\nARRIVAL");
    printTimeRange(arrival);

    console.log("\nDEPARTURE");
    printTimeRange(departure);

    console.log("\nTRANSFER");
    printTimeRange(ret);


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

    const s = globalResolution;
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
        /*
        if(i > 0 && ret[i][1] > 0.002 && firstSignificant == 0) {
            ret[i - 1][1] = 0;
            firstSignificant = i - 1;
        }
        if(ret[i][1] > 0.998) {
            return ret.slice(firstSignificant, i).concat( [[ ret[i][0], 1 ]]);
        }*/
    }

    return simplify(ret);
}