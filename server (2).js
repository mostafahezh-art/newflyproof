const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = 'c4632b8ac2msh212c4b52b4297d2p1f4e40jsna1d0697f430a';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';

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

function sendBrevoEmail(toEmail, toName, bookingRef, flightRoute, flightDate, airline, htmlContent, callback) {
  var emailData = JSON.stringify({
    sender: { name: 'FlightStamp', email: 'bookings@flightstamp.com' },
    to: [{ email: toEmail, name: toName }],
    subject: 'Your FlightStamp Booking Confirmation - ' + bookingRef,
    htmlContent: htmlContent
  });

  var options = {
    hostname: 'api.brevo.com',
    path: '/v3/smtp/email',
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(emailData)
    }
  };

  var req = https.request(options, function(res) {
    var raw = '';
    res.on('data', function(chunk) { raw += chunk; });
    res.on('end', function() {
      console.log('Brevo response:', res.statusCode, raw.substring(0, 200));
      callback(null, res.statusCode);
    });
  });
  req.on('error', function(err) { callback(err); });
  req.write(emailData);
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

  // ── Flights ──────────────────────────────────────────────────────
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

  // ── Payment ──────────────────────────────────────────────────────
  if (url.pathname === '/pay' && req.method === 'POST') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (!data.token) { res.end(JSON.stringify({ success: false, error: 'No token' })); return; }
        stripeCharge(data.token, 500, function(err, charge) {
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

  // ── Send Email ───────────────────────────────────────────────────
  if (url.pathname === '/send-email' && req.method === 'POST') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        var toEmail = data.email || '';
        var toName = data.name || 'Traveler';
        var bookingRef = data.bookingRef || '';
        var flightRoute = data.flightRoute || '';
        var flightDate = data.flightDate || '';
        var airline = data.airline || '';
        var flightNum = data.flightNum || '';
        var depTime = data.depTime || '';
        var arrTime = data.arrTime || '';

        if (!toEmail) { res.end(JSON.stringify({ success: false, error: 'No email' })); return; }

        var htmlContent = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif">'
          + '<div style="max-width:600px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">'
          + '<div style="background:linear-gradient(135deg,#1d4ed8,#2563eb);padding:32px 36px">'
          + '<div style="color:#fff;font-size:24px;font-weight:700;letter-spacing:-.5px">✈ FlightStamp</div>'
          + '<div style="color:rgba(255,255,255,.8);font-size:14px;margin-top:4px">Proof of Onward Travel</div>'
          + '</div>'
          + '<div style="padding:32px 36px">'
          + '<h2 style="color:#0f172a;font-size:20px;margin:0 0 6px">Booking Confirmed!</h2>'
          + '<p style="color:#64748b;font-size:14px;margin:0 0 24px">Dear ' + toName + ', your flight itinerary is ready.</p>'
          + '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:20px 24px;margin-bottom:24px">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
          + '<div><div style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Booking Reference</div>'
          + '<div style="font-size:22px;font-weight:800;color:#1d4ed8;margin-top:2px">' + bookingRef + '</div></div>'
          + '<div style="text-align:right"><div style="font-size:12px;color:#64748b">Amount Paid</div>'
          + '<div style="font-size:20px;font-weight:700;color:#16a34a">$5.00</div></div>'
          + '</div>'
          + '<div style="border-top:1px solid #bfdbfe;padding-top:16px">'
          + '<table style="width:100%;border-collapse:collapse">'
          + '<tr><td style="padding:6px 0;font-size:13px;color:#64748b;width:140px">✈ Flight</td><td style="font-size:13px;font-weight:600;color:#0f172a">' + flightNum + ' · ' + airline + '</td></tr>'
          + '<tr><td style="padding:6px 0;font-size:13px;color:#64748b">🛫 Route</td><td style="font-size:13px;font-weight:600;color:#0f172a">' + flightRoute + '</td></tr>'
          + '<tr><td style="padding:6px 0;font-size:13px;color:#64748b">📅 Date</td><td style="font-size:13px;font-weight:600;color:#0f172a">' + flightDate + '</td></tr>'
          + '<tr><td style="padding:6px 0;font-size:13px;color:#64748b">🕐 Departure</td><td style="font-size:13px;font-weight:600;color:#0f172a">' + depTime + '</td></tr>'
          + '<tr><td style="padding:6px 0;font-size:13px;color:#64748b">🕐 Arrival</td><td style="font-size:13px;font-weight:600;color:#0f172a">' + arrTime + '</td></tr>'
          + '<tr><td style="padding:6px 0;font-size:13px;color:#64748b">👤 Passenger</td><td style="font-size:13px;font-weight:600;color:#0f172a">' + toName + '</td></tr>'
          + '</table></div></div>'
          + '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-bottom:24px">'
          + '<div style="font-size:14px;font-weight:600;color:#16a34a;margin-bottom:6px">📄 Your PDF Ticket</div>'
          + '<div style="font-size:13px;color:#166534">Your full booking confirmation PDF was generated on our site. Please save it from your browser or visit <a href="https://flightstamp.com" style="color:#1d4ed8">flightstamp.com</a> to download it again.</div>'
          + '</div>'
          + '<div style="font-size:12px;color:#94a3b8;text-align:center;border-top:1px solid #e2e8f0;padding-top:20px">'
          + '© 2026 FlightStamp · <a href="https://flightstamp.com" style="color:#64748b">flightstamp.com</a><br>'
          + 'For travel planning and visa application purposes only.'
          + '</div></div></div></body></html>';

        sendBrevoEmail(toEmail, toName, bookingRef, flightRoute, flightDate, airline, htmlContent, function(err, status) {
          if (err) {
            res.end(JSON.stringify({ success: false, error: err.message }));
          } else {
            res.end(JSON.stringify({ success: true, status: status }));
          }
        });
      } catch(e) {
        res.end(JSON.stringify({ success: false, error: 'Invalid request: ' + e.message }));
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
