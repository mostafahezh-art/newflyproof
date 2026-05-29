const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = 'c4632b8ac2msh212c4b52b4297d2p1f4e40jsna1d0697f430a';

function fetchSchedule(dep, fromDateTime, toDateTime, callback) {
  var path = '/flights/airports/iata/' + dep + '/' + fromDateTime + '/' + toDateTime + '?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false';
  var options = {
    hostname: 'aerodatabox.p.rapidapi.com',
    path: path,
    method: 'GET',
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
      'Accept': 'application/json'
    }
  };
  var apiReq = https.request(options, function(apiRes) {
    var raw = '';
    apiRes.on('data', function(chunk) { raw += chunk; });
    apiRes.on('end', function() {
      try {
        var data = JSON.parse(raw);
        callback(null, data.departures || []);
      } catch(e) {
        callback(null, []);
      }
    });
  });
  apiReq.on('error', function() { callback(null, []); });
  apiReq.end();
}

const server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  var url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/flights') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  var dep = url.searchParams.get('dep') || '';
  var arr = url.searchParams.get('arr') || '';
  var date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];

  if (!dep || !arr) {
    res.writeHead(400);
    res.end(JSON.stringify({ flights: [], error: 'Missing dep or arr' }));
    return;
  }

  // AeroDataBox max window is 12 hours - make 2 calls: morning + afternoon
  var morning_from = date + 'T00:00';
  var morning_to   = date + 'T11:59';
  var afternoon_from = date + 'T12:00';
  var afternoon_to   = date + 'T23:59';

  function parseFlights(departures, arr) {
    return departures.filter(function(f) {
      var destIata = f.arrival && f.arrival.airport && f.arrival.airport.iata;
      return destIata && destIata.toUpperCase() === arr.toUpperCase();
    }).map(function(f) {
      var depTimeRaw = f.departure && f.departure.scheduledTime
        ? (f.departure.scheduledTime.local || f.departure.scheduledTime.utc || '') : '';
      var arrTimeRaw = f.arrival && f.arrival.scheduledTime
        ? (f.arrival.scheduledTime.local || f.arrival.scheduledTime.utc || '') : '';

      var depTime = depTimeRaw.substring(11, 16);
      var arrTime = arrTimeRaw.substring(11, 16);

      var airlineIata = (f.airline && f.airline.iata) || '';
      var airlineName = (f.airline && f.airline.name) || 'Unknown';
      var num = (f.number || '').replace(/\s/g, '');
      var flightNum = num.startsWith(airlineIata) ? num : airlineIata + num;

      return {
        airline: airlineName,
        acode: airlineIata,
        flightNum: flightNum,
        iataFrom: (f.departure && f.departure.airport && f.departure.airport.iata) || dep,
        iataTo: (f.arrival && f.arrival.airport && f.arrival.airport.iata) || arr,
        cityFrom: (f.departure && f.departure.airport && f.departure.airport.municipalityName) || dep,
        cityTo: (f.arrival && f.arrival.airport && f.arrival.airport.municipalityName) || arr,
        depTime: depTime,
        arrTime: arrTime,
        terminal: (f.departure && f.departure.terminal) || '',
        arrTerminal: (f.arrival && f.arrival.terminal) || '',
        gate: (f.departure && f.departure.gate) || '',
        ac: (f.aircraft && f.aircraft.model) || ''
      };
    }).filter(function(f) { return f.depTime && f.depTime.length >= 4; });
  }

  // Fetch morning flights
  fetchSchedule(dep, morning_from, morning_to, function(err, morning) {
    // Fetch afternoon flights
    fetchSchedule(dep, afternoon_from, afternoon_to, function(err2, afternoon) {
      var all = morning.concat(afternoon);
      var flights = parseFlights(all, arr);
      res.end(JSON.stringify({ flights: flights, total: flights.length }));
    });
  });
});

server.listen(PORT, function() {
  console.log('FlyProof API running on port ' + PORT);
});
