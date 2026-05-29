const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = 'c4632b8ac2msh212c4b52b4297d2p1f4e40jsna1d0697f430a';

function makeRequest(path, callback) {
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
    apiRes.on('end', function() { callback(null, apiRes.statusCode, raw); });
  });
  apiReq.on('error', function(err) { callback(err); });
  apiReq.end();
}

const server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  var url = new URL(req.url, 'http://localhost');

  // Debug endpoint - shows raw AeroDataBox response
  if (url.pathname === '/debug') {
    var dep = url.searchParams.get('dep') || 'CAI';
    var date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
    var fromDateTime = date + 'T00:00';
    var toDateTime = date + 'T23:59';
    var path = '/flights/airports/iata/' + dep + '/' + fromDateTime + '/' + toDateTime + '?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false';
    
    makeRequest(path, function(err, status, raw) {
      if (err) { res.end(JSON.stringify({error: err.message})); return; }
      res.end(JSON.stringify({ status: status, path: path, raw: raw.substring(0, 2000) }));
    });
    return;
  }

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

  var fromDateTime = date + 'T00:00';
  var toDateTime = date + 'T23:59';
  var path = '/flights/airports/iata/' + dep + '/' + fromDateTime + '/' + toDateTime + '?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false';

  makeRequest(path, function(err, status, raw) {
    if (err) {
      res.end(JSON.stringify({ flights: [], error: err.message }));
      return;
    }

    try {
      var data = JSON.parse(raw);
      if (data.message || data.error) {
        res.end(JSON.stringify({ flights: [], error: data.message || data.error }));
        return;
      }

      var departures = data.departures || [];

      var filtered = departures.filter(function(f) {
        var destIata = f.arrival && f.arrival.airport && f.arrival.airport.iata;
        return destIata && destIata.toUpperCase() === arr.toUpperCase();
      });

      var flights = filtered.map(function(f) {
        var depTimeRaw = f.departure && f.departure.scheduledTime
          ? (f.departure.scheduledTime.local || f.departure.scheduledTime.utc || '') : '';
        var arrTimeRaw = f.arrival && f.arrival.scheduledTime
          ? (f.arrival.scheduledTime.local || f.arrival.scheduledTime.utc || '') : '';
        
        var depTime = depTimeRaw.replace('T', ' ').substring(11, 16) || depTimeRaw.substring(0, 5);
        var arrTime = arrTimeRaw.replace('T', ' ').substring(11, 16) || arrTimeRaw.substring(0, 5);

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

      res.end(JSON.stringify({ flights: flights, total: flights.length }));

    } catch(e) {
      res.end(JSON.stringify({ flights: [], error: 'Parse error: ' + e.message, raw: raw.substring(0, 500) }));
    }
  });
});

server.listen(PORT, function() {
  console.log('FlyProof API running on port ' + PORT);
});
