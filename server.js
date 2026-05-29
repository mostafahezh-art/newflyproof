const http = require('http');
const PORT = process.env.PORT || 3000;
const API_KEY = 'abfde02d0a42baf7685dc6226e4f2e07';

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

  if (!dep || !arr) {
    res.writeHead(400);
    res.end(JSON.stringify({ flights: [], error: 'Missing dep or arr' }));
    return;
  }

  var apiUrl = 'http://api.aviationstack.com/v1/flights?access_key=' + API_KEY + '&dep_iata=' + dep + '&arr_iata=' + arr + '&limit=10&flight_status=scheduled';

  http.get(apiUrl, function(apiRes) {
    var raw = '';
    apiRes.on('data', function(chunk) { raw += chunk; });
    apiRes.on('end', function() {
      try {
        var data = JSON.parse(raw);
        if (data.error) {
          res.writeHead(200);
          res.end(JSON.stringify({ flights: [], error: data.error.message }));
          return;
        }
        var flights = (data.data || []).map(function(f) {
          return {
            airline:     (f.airline && f.airline.name) || 'Unknown',
            acode:       (f.airline && f.airline.iata) || '??',
            flightNum:   ((f.airline && f.airline.iata) || '') + ((f.flight && f.flight.number) || ''),
            iataFrom:    (f.departure && f.departure.iata) || dep,
            iataTo:      (f.arrival && f.arrival.iata) || arr,
            cityFrom:    (f.departure && f.departure.airport) || dep,
            cityTo:      (f.arrival && f.arrival.airport) || arr,
            depTime:     ((f.departure && f.departure.scheduled) || '').substring(11,16),
            arrTime:     ((f.arrival && f.arrival.scheduled) || '').substring(11,16),
            terminal:    (f.departure && f.departure.terminal) || '1',
            arrTerminal: (f.arrival && f.arrival.terminal) || '1',
            gate:        (f.departure && f.departure.gate) || '',
            ac:          (f.aircraft && f.aircraft.iata) || ''
          };
        }).filter(function(f) { return f.depTime && f.depTime.length >= 4; });

        res.writeHead(200);
        res.end(JSON.stringify({ flights: flights }));
      } catch(e) {
        res.writeHead(200);
        res.end(JSON.stringify({ flights: [], error: 'Parse error: ' + e.message }));
      }
    });
  }).on('error', function(err) {
    res.writeHead(200);
    res.end(JSON.stringify({ flights: [], error: err.message }));
  });
});

server.listen(PORT, function() {
  console.log('FlyProof API running on port ' + PORT);
});
