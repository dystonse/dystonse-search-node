var ndjson = require('ndjson');
var fs = require('fs');
const printf = require('printf');

const lines = require('vbb-lines');
const vbbtrips = require('vbb-trips');
const toArray = require('stream-to-array');
const lines_at = require('vbb-lines-at');
const stations = require('vbb-stations/full.json');

var trips = {};
var tripsByLine = {};
var productByLine = {};
var stationByStop = {};
var all_schedules;
var linesById = {};
var stopsByLinename = {};
var delayAfterDelay = {};

var scheduleArray = toArray(vbbtrips.schedules());

var travelSum = 0;
var sampleCount = 0;

var departureCounts = {};
var departureCountsSum = 0;

// pseudo-main:
(async () => {
    //console.log(await vbbtrips.schedules(true, "25526"));
    console.log("Indexing data");

    console.log("Searching schedules");
   
    var subway_schedules = await getSchedulesForProduct("subway");
    var sbahn_schedules = await getSchedulesForProduct("suburban");
    var bus_schedules = await getSchedulesForProduct("bus");
    all_schedules = subway_schedules.concat(sbahn_schedules).concat(bus_schedules);
    indexStops();
   
    //fs.createReadStream('vbb-delays_2019-03-05_2019-03-07.ndjson')
    fs.createReadStream('vbb-delays_2019-03-04_2019-03-05.ndjson')
        .pipe(ndjson.parse())
        .on('data', function(array) {
            const record = array; //[1];

            if(!record.when || record.delay === null) 
                return;

            if(record.line.product != "suburban")
                return;

                
            record.delay /= 60;
                
            var count = departureCounts[record.delay];
            if(!count) {
                departureCounts[record.delay] = 1;
            } else {
                departureCounts[record.delay] = count + 1;
            }
            departureCountsSum++;
            
            var trip = trips[record.trip];
            if(!trip) {
                trip = {
                    "id": trips[record.trip],
                    "runs": {}
                };
                trips[record.trip] = trip;

                const line = record.line.name;
                if(!tripsByLine[line]) {
                    tripsByLine[line] = {};
                    productByLine[line] = record.line.product;
                }

                tripsByLine[line][record.trip] = trip;
            }

            //var fahrtNr = record.line.fahrtNr;
            var fahrtNr = record.tripId;
            
            var run = trip.runs[fahrtNr];
            if(!run) {
                run = [];
                trip.runs[fahrtNr] = run;
            }
            
            run.push(record);
        })
        .on('finish', async function() {
            console.log("Indexing Done.");
            await analyse();
            printResults();
        }
        )
    }
)();

async function analyse() {
    for (const lineName in tripsByLine) {
        var foundStops = false;
        //const lineName = "50";
        // convert the route from stop-ids to station-ids
        var lines = await vbbtrips.lines(true, {"name":lineName});
        for (const line of lines) {
            //console.log("Line " + lineName + " could be ID " + line.id); // Damit könnte ich in den schedules suchen
            if(line.product == productByLine[lineName]) {
                //console.log("Found line " + lineName);
                var matchingSchedules =  all_schedules.filter(schedule => schedule.route.line == line.id);
                if(matchingSchedules.length > 0) {
                    matchingSchedules.sort( (s1, s2) => s2.route.stops.length - s1.route.stops.length);
                    var longestRoute = matchingSchedules[0].route;
                    var i = 1;
                    foundStops = true;
                    stopsByLinename[lineName] = [];
                    for (const stop of longestRoute.stops) {
                        var station = stationByStop[stop];
                        if(station)
                            stopsByLinename[lineName].push(station.id);
                    }
                }
            }
        }
        

        if (tripsByLine.hasOwnProperty(lineName) && foundStops) {
            const trips = tripsByLine[lineName];

            for (const tripId in trips) {
                if (trips.hasOwnProperty(tripId)) {
                    const trip = trips[tripId];
                    //console.log("  Trip: " + tripId);
                    analyseTrip(trip);
                }
            }
        }
   }
}

function analyseTrip(trip) {
    for (const runId in trip.runs) {
        if (trip.runs.hasOwnProperty(runId)) {
            //console.log("    Run: " + runId);
            const run = trip.runs[runId];
            analyseRun(run);
            return;
        }
    }
}

function analyseRun(run) {
    run.sort( (dep1, dep2) => dep1.when.localeCompare(dep2.when) );
    var lastStopName = "";
    var lastStopIndex = -1;
    var filteredDeps = [];
    var direction = 0;
    
    for (const dep of run) {
        if(dep.stop.name != lastStopName) {
            var stops = stopsByLinename[dep.line.name];
            if(!stops) {
                return;
            }
            dep.stopIndex = stops.indexOf(dep.stop.id);
            if(dep.stopIndex == -1) {
                return;
            }
            filteredDeps.push(dep);
            if(dep.stopIndex != -1 && lastStopIndex != -1) {
                var newDirection = Math.sign(dep.stopIndex - lastStopIndex);
                if(direction == 0) {
                    direction = newDirection;
                } else {
                    if(direction != newDirection) {
                        // console.log("      " + dep.tripId + " changes direction.");
                        return;
                    }
                }
            }
            lastStopIndex = dep.stopIndex;
        }
        lastStopName = dep.stop.name;
    }
    run.length = 0; // clear the array
    run.push(...filteredDeps);

    if(run.length < 3) {
        //console.log("      is too short.");
        return;
    }

    //console.log(run[0].line.name + " starting at " + run[0].when);
    var previousDelay = 1000;
    var previousWhen;
    for (const dep of run) {
        //console.log("      At stop " + dep.stopIndex + " delay is " + dep.delay);
        var when = new Date(dep.when);
        if(previousDelay != 1000) {
            var travelMinutes = (when - previousWhen) / (60 * 1000); // minutes
            if(travelMinutes < 0 || travelMinutes > 30) {
                console.log("Invalid span: " + travelMinutes);
                continue;
            }

            if(!delayAfterDelay[previousDelay])
                delayAfterDelay[previousDelay] = {};
            if(!delayAfterDelay[previousDelay][dep.delay])
                delayAfterDelay[previousDelay][dep.delay] = 0;
            delayAfterDelay[previousDelay][dep.delay]++;

            sampleCount++;
            travelSum += travelMinutes;
        }
        previousWhen = when;
        previousDelay = dep.delay;
        
    }
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
    for (const key in stations) {
        if (stations.hasOwnProperty(key)) {
            const station = stations[key];
            for (stop of station.stops) {
                stationByStop[stop.id] = station;
            }
        }
    }
}

function printResults() {
    var average = (travelSum / sampleCount);
    for (const preDeleay in delayAfterDelay) {
        if (delayAfterDelay.hasOwnProperty(preDeleay)) {
            var nextDelays = delayAfterDelay[preDeleay];
            console.log("If current delay is " + preDeleay);

            var overallCount = 0;
            for (const nextDelay in nextDelays) {
                if (nextDelays.hasOwnProperty(nextDelay)) {
                    const count = nextDelays[nextDelay];
                    overallCount += count;
                }
            }
            /*
            for (const nextDelay in nextDelays) {
                if (nextDelays.hasOwnProperty(nextDelay)) {
                    const count = nextDelays[nextDelay];
                    console.log("    Overall delay " + nextDelay + " minutes in " + (Math.round(count / overallCount * 10000) / 100) + "%");
                }
            }*/

            var sortedKeys = Object.keys(nextDelays).sort( (a,b) => a-b );
            //console.log(sortedKeys);
            var pSum = 0;
            for (const nextDelay of sortedKeys) {
                const count = nextDelays[nextDelay];
                var travelTime = 60 + Math.floor(nextDelay * 60 - preDeleay * 60) / average;
                pSum += (Math.round(count / overallCount * 10000) / 10000);
                console.log(printf("[% 4d, %0.2f],", Math.floor(travelTime),  pSum));
            }

            console.log("(based on " + overallCount +" samples)\n");
        }
    }

    console.log("Average travel time between data points: " + average);

    console.log("Departures:");
    var sortedKeys = Object.keys(departureCounts).sort( (a,b) => a-b );
    //console.log(sortedKeys);
    var pSum = 0;
    for (const departure of sortedKeys) {
        const count = departureCounts[departure];

        pSum += count / departureCountsSum;
        console.log(printf("[% 4d, %0.2f],", Math.floor(departure * 60),  pSum));
    }
}