const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = 'c4632b8ac2msh212c4b52b4297d2p1f4e40jsna1d0697f430a';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';

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
      try { callback(null, JSON.parse(raw).departures || []); }
      catch(e) { callback(null, []); }
    });
  });
  apiReq.on('error', function() { callback(null, []); });
  apiReq.end();
}

function stripeCharge(token, amount, callback) {
  var postData = 'amount=' + amount + '&currency=usd&source=' + token + '&description=FlightStamp+Booking+Confirmation';
  var options = {
    hostname: 'api.stripe.com',
    path: '/v1/charges',
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(STRIPE_SECRET + ':').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  var req = https.request(options, function(res) {
    var raw = '';
    res.on('data', function(chunk) { raw += chunk; });
    res.on('end', function() {
      try { callback(null, JSON.parse(raw)); }
      catch(e) { callback(new Error('Parse error')); }
    });
  });
  req.on('error', callback);
  req.write(postData);
  req.end();
}

function parseFlights(departures, arr) {
  return departures.filter(function(f) {
    var destIata = f.arrival && f.arrival.airport && f.arrival.airport.iata;
    return destIata && destIata.toUpperCase() === arr.toUpperCase();
  }).map(function(f) {
    var depTimeRaw = f.departure && f.departure.scheduledTime
      ? (f.departure.scheduledTime.local || f.departure.scheduledTime.utc || '') : '';
    var arrTimeRaw = f.arrival && f.arrival.scheduledTime
      ? (f.arrival.scheduledTime.local || f.arrival.scheduledTime.utc || '') : '';
    var airlineIata = (f.airline && f.airline.iata) || '';
    var airlineName = (f.airline && f.airline.name) || 'Unknown';
    var num = (f.number || '').replace(/\s/g, '');
    var flightNum = num.startsWith(airlineIata) ? num : airlineIata + num;
    return {
      airline: airlineName, acode: airlineIata, flightNum: flightNum,
      iataFrom: (f.departure && f.departure.airport && f.departure.airport.iata) || '',
      iataTo: (f.arrival && f.arrival.airport && f.arrival.airport.iata) || '',
      cityFrom: (f.departure && f.departure.airport && f.departure.airport.municipalityName) || '',
      cityTo: (f.arrival && f.arrival.airport && f.arrival.airport.municipalityName) || '',
      depTime: depTimeRaw.substring(11, 16),
      arrTime: arrTimeRaw.substring(11, 16),
      terminal: (f.departure && f.departure.terminal) || '',
      arrTerminal: (f.arrival && f.arrival.terminal) || '',
      gate: (f.departure && f.departure.gate) || '',
      ac: (f.aircraft && f.aircraft.model) || ''
    };
  }).filter(function(f) { return f.depTime && f.depTime.length >= 4; });
}

const server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  var url = new URL(req.url, 'http://localhost');

  // ── Flights endpoint ─────────────────────────────────────────────
  if (url.pathname === '/flights') {
    var dep = url.searchParams.get('dep') || '';
    var arr = url.searchParams.get('arr') || '';
    var date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
    if (!dep || !arr) { res.end(JSON.stringify({ flights: [], error: 'Missing dep or arr' })); return; }
    var morning_from = date + 'T00:00', morning_to = date + 'T11:59';
    var afternoon_from = date + 'T12:00', afternoon_to = date + 'T23:59';
    fetchSchedule(dep, morning_from, morning_to, function(err, morning) {
      fetchSchedule(dep, afternoon_from, afternoon_to, function(err2, afternoon) {
        var flights = parseFlights(morning.concat(afternoon), arr);
        res.end(JSON.stringify({ flights: flights, total: flights.length }));
      });
    });
    return;
  }

  // ── Payment endpoint ─────────────────────────────────────────────
  if (url.pathname === '/pay' && req.method === 'POST') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        var token = data.token;
        if (!token) { res.end(JSON.stringify({ success: false, error: 'No token' })); return; }
        stripeCharge(token, 500, function(err, charge) {
          if (err || charge.error) {
            res.end(JSON.stringify({ success: false, error: err ? err.message : charge.error.message }));
          } else {
            res.end(JSON.stringify({ success: true, chargeId: charge.id }));
          }
        });
      } catch(e) {
        res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, function() {
  console.log('FlightStamp API running on port ' + PORT);
});
