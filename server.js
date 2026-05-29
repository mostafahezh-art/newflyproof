const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = 'c4632b8ac2msh212c4b52b4297d2p1f4e40jsna1d0697f430a';

const server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

  // AeroDataBox: get airport schedule for departure airport on given date
  // Endpoint: /flights/airports/iata/{iata}/{date}T00:00/{date}T23:59
  var fromDate = date + 'T00:00';
  var toDate = date + 'T23:59';
  var path = '/flights/airports/iata/' + dep + '/' + fromDate + '/' + toDate + '?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false';

  var options = {
    hostname: 'aerodatabox.p.rapidapi.com',
    path: path,
    method: 'GET',
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': 'aerodatabox.p.rapidapi.com'
    }
  };

  console.log('Calling AeroDataBox:', dep, '->', arr, 'on', date);

  var apiReq = https.request(options, function(apiRes) {
    var raw = '';
    apiRes.on('data', function(chunk) { raw += chunk; });
    apiRes.on('end', function() {
      try {
        var data = JSON.parse(raw);
        console.log('AeroDataBox response keys:', Object.keys(data));

        var departures = data.departures || data.arrivals || data || [];
        if (!Array.isArray(departures)) departures = [];

        // Filter to only flights going to our destination
        var filtered = departures.filter(function(f) {
          var destIata = f.arrival && f.arrival.airport && f.arrival.airport.iata;
          return destIata && destIata.toUpperCase() === arr.toUpperCase();
        });

        console.log('Total departures:', departures.length, 'To', arr+':', filtered.length);

        var flights = filtered.map(function(f) {
          var depTime = (f.departure && f.departure.scheduledTime && f.departure.scheduledTime.local)
            ? f.departure.scheduledTime.local.substring(11,16)
            : (f.departure && f.departure.scheduledTime && f.departure.scheduledTime.utc)
            ? f.departure.scheduledTime.utc.substring(11,16) : '';

          var arrTime = (f.arrival && f.arrival.scheduledTime && f.arrival.scheduledTime.local)
            ? f.arrival.scheduledTime.local.substring(11,16)
            : (f.arrival && f.arrival.scheduledTime && f.arrival.scheduledTime.utc)
            ? f.arrival.scheduledTime.utc.substring(11,16) : '';

          var airlineIata = (f.airline && f.airline.iata) || '';
          var airlineName = (f.airline && f.airline.name) || 'Unknown';
          var flightNum = airlineIata + ((f.number || '').replace(airlineIata,''));
          var terminal = (f.departure && f.departure.terminal) || '1';
          var arrTerminal = (f.arrival && f.arrival.terminal) || '1';
          var gate = (f.departure && f.departure.gate) || '';
          var ac = (f.aircraft && f.aircraft.model) || '';

          return {
            airline: airlineName,
            acode: airlineIata,
            flightNum: flightNum,
            iataFrom: dep,
            iataTo: arr,
            cityFrom: (f.departure && f.departure.airport && f.departure.airport.name) || dep,
            cityTo: (f.arrival && f.arrival.airport && f.arrival.airport.name) || arr,
            depTime: depTime,
            arrTime: arrTime,
            terminal: terminal,
            arrTerminal: arrTerminal,
            gate: gate,
            ac: ac
          };
        }).filter(function(f) { return f.depTime && f.depTime.length >= 4; });

        res.writeHead(200);
        res.end(JSON.stringify({ flights: flights, total: flights.length }));

      } catch(e) {
        console.error('Parse error:', e.message, 'Raw:', raw.substring(0,200));
        res.writeHead(200);
        res.end(JSON.stringify({ flights: [], error: 'Parse error: ' + e.message }));
      }
    });
  });

  apiReq.on('error', function(err) {
    console.error('Request error:', err.message);
    res.writeHead(200);
    res.end(JSON.stringify({ flights: [], error: err.message }));
  });

  apiReq.end();
});

server.listen(PORT, function() {
  console.log('FlyProof API (AeroDataBox) running on port ' + PORT);
});
