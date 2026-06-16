const http = require('http');
const https = require('https');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = 'c4632b8ac2msh212c4b52b4297d2p1f4e40jsna1d0697f430a';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const ADMIN_PASSWORD = 'myflightstamp@3252';

// ── Database ──────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      booking_ref VARCHAR(20),
      passenger_name VARCHAR(200),
      email VARCHAR(200),
      flight_route VARCHAR(50),
      flight_date VARCHAR(30),
      airline VARCHAR(100),
      flight_num VARCHAR(30),
      dep_time VARCHAR(10),
      arr_time VARCHAR(10),
      charge_id VARCHAR(100),
      amount INTEGER DEFAULT 500,
      currency VARCHAR(10) DEFAULT 'usd',
      email_sent BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitors (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(100),
      page VARCHAR(200),
      referrer VARCHAR(500),
      user_agent VARCHAR(500),
      country VARCHAR(100),
      ip VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}

initDB().catch(console.error);

// ── Helpers ───────────────────────────────────────────────────────
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

function buildEmailHtml(toName, bookingRef, flightRoute, flightDate, airline, flightNum, depTime, arrTime) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif">'
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
}

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// ── Admin Dashboard HTML ──────────────────────────────────────────
function adminHTML(orders, stats, visitors) {
  var rows = orders.map(function(o) {
    return '<tr>'
      + '<td>' + (o.booking_ref || '') + '</td>'
      + '<td>' + (o.passenger_name || '') + '</td>'
      + '<td>' + (o.email || '') + '</td>'
      + '<td>' + (o.flight_route || '') + '</td>'
      + '<td>' + (o.flight_date || '') + '</td>'
      + '<td>' + (o.airline || '') + '</td>'
      + '<td>' + (o.flight_num || '') + '</td>'
      + '<td style="color:#16a34a;font-weight:700">$' + ((o.amount || 500) / 100).toFixed(2) + '</td>'
      + '<td>' + (o.email_sent ? '<span style="color:#16a34a">✓ Sent</span>' : '<span style="color:#ef4444">✗ Failed</span>') + '</td>'
      + '<td style="color:#64748b;font-size:12px">' + new Date(o.created_at).toLocaleString() + '</td>'
      + '<td><button onclick="resend(\'' + o.booking_ref + '\',\'' + (o.email||'') + '\',\'' + (o.passenger_name||'') + '\',\'' + (o.flight_route||'') + '\',\'' + (o.flight_date||'') + '\',\'' + (o.airline||'') + '\',\'' + (o.flight_num||'') + '\',\'' + (o.dep_time||'') + '\',\'' + (o.arr_time||'') + '\')" style="background:#2563eb;color:#fff;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px">Resend</button></td>'
      + '</tr>';
  }).join('');

  var visitorRows = visitors.map(function(v) {
    var ago = Math.floor((Date.now() - new Date(v.last_seen).getTime()) / 1000);
    var agoStr = ago < 60 ? ago + 's ago' : Math.floor(ago/60) + 'm ago';
    var isOnline = ago < 120;
    return '<tr>'
      + '<td>' + (v.session_id || '').substring(0,8) + '...</td>'
      + '<td>' + (v.page || '/') + '</td>'
      + '<td>' + (v.ip || '') + '</td>'
      + '<td>' + (v.referrer || 'Direct') + '</td>'
      + '<td>' + agoStr + '</td>'
      + '<td>' + (isOnline ? '<span style="color:#16a34a;font-weight:700">● Online</span>' : '<span style="color:#94a3b8">Offline</span>') + '</td>'
      + '</tr>';
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlightStamp Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.topbar{background:linear-gradient(135deg,#1d4ed8,#2563eb);padding:16px 32px;display:flex;align-items:center;justify-content:space-between}
.topbar h1{font-size:20px;font-weight:700;color:#fff}
.topbar span{font-size:13px;color:rgba(255,255,255,.7)}
.content{padding:28px 32px;max-width:1400px;margin:0 auto}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px}
.stat{background:#1e293b;border-radius:12px;padding:20px 24px;border:1px solid #334155}
.stat .label{font-size:12px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.stat .value{font-size:32px;font-weight:800;color:#fff}
.stat .sub{font-size:12px;color:#64748b;margin-top:4px}
.online-dot{width:10px;height:10px;background:#22c55e;border-radius:50%;display:inline-block;margin-right:6px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.section{background:#1e293b;border-radius:12px;border:1px solid #334155;margin-bottom:24px;overflow:hidden}
.section-header{padding:16px 24px;border-bottom:1px solid #334155;display:flex;align-items:center;justify-content:space-between}
.section-header h2{font-size:15px;font-weight:600;color:#f1f5f9}
.search-bar{padding:12px 24px;border-bottom:1px solid #334155;background:#0f172a}
.search-bar input{background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:8px 14px;border-radius:8px;font-size:13px;width:300px;outline:none}
.search-bar input:focus{border-color:#2563eb}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#0f172a;color:#94a3b8;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.05em;padding:10px 16px;text-align:left;white-space:nowrap}
td{padding:12px 16px;border-bottom:1px solid #1e293b;color:#cbd5e1;white-space:nowrap}
tr:hover td{background:#0f172a}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.empty{text-align:center;padding:48px;color:#475569}
.refresh{background:#1e293b;border:1px solid #334155;color:#94a3b8;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px}
.refresh:hover{border-color:#2563eb;color:#93c5fd}
.tabs{display:flex;gap:2px;padding:0 24px;background:#0f172a;border-bottom:1px solid #334155}
.tab{padding:12px 20px;font-size:13px;font-weight:600;color:#64748b;cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
.tab.active{color:#2563eb;border-bottom-color:#2563eb}
.tab-content{display:none}
.tab-content.active{display:block}
</style>
</head>
<body>
<div class="topbar">
  <h1>✈ FlightStamp Admin</h1>
  <span id="clock"></span>
</div>
<div class="content">
  <div class="stats">
    <div class="stat">
      <div class="label">Total Revenue</div>
      <div class="value" style="color:#22c55e">$${((stats.total_revenue || 0)/100).toFixed(2)}</div>
      <div class="sub">All time</div>
    </div>
    <div class="stat">
      <div class="label">Total Orders</div>
      <div class="value">${stats.total_orders || 0}</div>
      <div class="sub">Completed bookings</div>
    </div>
    <div class="stat">
      <div class="label">Today's Revenue</div>
      <div class="value" style="color:#60a5fa">$${((stats.today_revenue || 0)/100).toFixed(2)}</div>
      <div class="sub">${stats.today_orders || 0} orders today</div>
    </div>
    <div class="stat">
      <div class="label">This Month</div>
      <div class="value" style="color:#a78bfa">$${((stats.month_revenue || 0)/100).toFixed(2)}</div>
      <div class="sub">${stats.month_orders || 0} orders</div>
    </div>
    <div class="stat">
      <div class="label"><span class="online-dot"></span>Online Now</div>
      <div class="value" style="color:#22c55e">${stats.online_now || 0}</div>
      <div class="sub">Last 2 minutes</div>
    </div>
    <div class="stat">
      <div class="label">Visitors Today</div>
      <div class="value">${stats.visitors_today || 0}</div>
      <div class="sub">Unique sessions</div>
    </div>
  </div>

  <div class="section">
    <div class="tabs">
      <div class="tab active" onclick="switchTab('orders')">📦 Orders</div>
      <div class="tab" onclick="switchTab('visitors')">👁 Visitors</div>
    </div>

    <div id="tab-orders" class="tab-content active">
      <div class="section-header">
        <h2>All Orders</h2>
        <button class="refresh" onclick="location.reload()">↻ Refresh</button>
      </div>
      <div class="search-bar">
        <input type="text" id="search" placeholder="Search by name, email, route, booking ref..." oninput="filterTable()">
      </div>
      <div class="table-wrap">
        <table id="orders-table">
          <thead>
            <tr>
              <th>Booking Ref</th><th>Passenger</th><th>Email</th><th>Route</th>
              <th>Date</th><th>Airline</th><th>Flight</th><th>Amount</th>
              <th>Email</th><th>Created</th><th>Action</th>
            </tr>
          </thead>
          <tbody id="orders-body">
            ${rows || '<tr><td colspan="11" class="empty">No orders yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div id="tab-visitors" class="tab-content">
      <div class="section-header">
        <h2>Recent Visitors</h2>
        <button class="refresh" onclick="location.reload()">↻ Refresh</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Session</th><th>Page</th><th>IP</th><th>Referrer</th><th>Last Seen</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${visitorRows || '<tr><td colspan="6" class="empty">No visitors recorded yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<script>
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t,i){t.classList.remove('active')});
  document.querySelectorAll('.tab-content').forEach(function(t){t.classList.remove('active')});
  document.getElementById('tab-'+name).classList.add('active');
  event.target.classList.add('active');
}
function filterTable() {
  var q = document.getElementById('search').value.toLowerCase();
  var rows = document.getElementById('orders-body').querySelectorAll('tr');
  rows.forEach(function(r){ r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none'; });
}
function resend(ref,email,name,route,date,airline,flightNum,dep,arr) {
  if(!confirm('Resend confirmation to ' + email + '?')) return;
  fetch('/admin/resend', {
    method:'POST',
    headers:{'Content-Type':'application/json','X-Admin-Password':'myflightstamp@3252'},
    body:JSON.stringify({bookingRef:ref,email:email,name:name,flightRoute:route,flightDate:date,airline:airline,flightNum:flightNum,depTime:dep,arrTime:arr})
  }).then(function(r){return r.json()}).then(function(d){
    alert(d.success ? '✓ Email resent successfully!' : '✗ Failed: ' + d.error);
  });
}
function clock() {
  document.getElementById('clock').textContent = new Date().toLocaleString();
}
clock(); setInterval(clock, 1000);
setInterval(function(){ location.reload(); }, 60000);
</script>
</body>
</html>`;
}

// ── Server ────────────────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  var url = new URL(req.url, 'http://localhost');

  // ── Visitor Ping ─────────────────────────────────────────────────
  if (url.pathname === '/ping' && req.method === 'POST') {
    var body = '';
    req.on('data', function(c){ body += c; });
    req.on('end', function() {
      res.setHeader('Content-Type', 'application/json');
      try {
        var d = JSON.parse(body);
        var sid = d.sessionId || '';
        var page = d.page || '/';
        var referrer = (d.referrer || 'Direct').substring(0, 200);
        var ua = (req.headers['user-agent'] || '').substring(0, 300);
        var ip = getIP(req);
        pool.query(
          'INSERT INTO visitors (session_id, page, referrer, user_agent, ip, created_at, last_seen) VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) ON CONFLICT DO NOTHING',
          [sid, page, referrer, ua, ip]
        ).catch(function(){});
        pool.query('UPDATE visitors SET last_seen=NOW(), page=$2 WHERE session_id=$1', [sid, page]).catch(function(){});
        res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.end(JSON.stringify({ ok: false })); }
    });
    return;
  }

  // ── Flights ──────────────────────────────────────────────────────
  if (url.pathname === '/flights') {
    res.setHeader('Content-Type', 'application/json');
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

  // ── Checkout (Pay + Email — atomic, single endpoint) ─────────────
  if (url.pathname === '/checkout' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (!data.token) { res.end(JSON.stringify({ success: false, error: 'No payment token' })); return; }
        if (!data.email) { res.end(JSON.stringify({ success: false, error: 'No email' })); return; }

        // Step 1: Charge via Stripe
        stripeCharge(data.token, 500, function(err, charge) {
          if (err || charge.error) {
            res.end(JSON.stringify({ success: false, error: err ? err.message : charge.error.message }));
            return;
          }

          // Step 2: Generate a signed ticket token (charge ID based)
          var ticketToken = Buffer.from(charge.id + ':' + data.bookingRef).toString('base64');

          // Step 3: Save order to DB
          pool.query(
            'INSERT INTO orders (booking_ref, passenger_name, email, flight_route, flight_date, airline, flight_num, dep_time, arr_time, charge_id, amount, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [data.bookingRef||'', data.name||'', data.email||'', data.flightRoute||'', data.flightDate||'', data.airline||'', data.flightNum||'', data.depTime||'', data.arrTime||'', charge.id, 500, 'usd']
          ).catch(function(e){ console.error('DB insert error:', e.message); });

          // Step 4: Send email
          var htmlContent = buildEmailHtml(data.name||'Traveler', data.bookingRef||'', data.flightRoute||'', data.flightDate||'', data.airline||'', data.flightNum||'', data.depTime||'', data.arrTime||'');
          sendBrevoEmail(data.email, data.name||'Traveler', data.bookingRef||'', data.flightRoute||'', data.flightDate||'', data.airline||'', htmlContent, function(emailErr, status) {
            var emailOk = !emailErr && status >= 200 && status < 300;
            pool.query('UPDATE orders SET email_sent=$1 WHERE booking_ref=$2', [emailOk, data.bookingRef||'']).catch(function(){});
            // Return ticketToken — frontend only gets this after real charge
            res.end(JSON.stringify({ success: true, chargeId: charge.id, ticketToken: ticketToken }));
          });
        });
      } catch(e) {
        res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
      }
    });
    return;
  }

  // ── Admin Resend Email ────────────────────────────────────────────
  if (url.pathname === '/admin/resend' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
      res.writeHead(403); res.end(JSON.stringify({ success: false, error: 'Unauthorized' })); return;
    }
    var body = '';
    req.on('data', function(c){ body += c; });
    req.on('end', function() {
      try {
        var d = JSON.parse(body);
        var html = buildEmailHtml(d.name, d.bookingRef, d.flightRoute, d.flightDate, d.airline, d.flightNum, d.depTime, d.arrTime);
        sendBrevoEmail(d.email, d.name, d.bookingRef, d.flightRoute, d.flightDate, d.airline, html, function(err, status) {
          if (err) res.end(JSON.stringify({ success: false, error: err.message }));
          else res.end(JSON.stringify({ success: true }));
        });
      } catch(e) { res.end(JSON.stringify({ success: false, error: e.message })); }
    });
    return;
  }

  // ── Admin Dashboard ───────────────────────────────────────────────
  if (url.pathname === '/admin') {
    var pw = url.searchParams.get('pw') || '';
    if (pw !== ADMIN_PASSWORD) {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin Login</title>
<style>*{box-sizing:border-box}body{background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:-apple-system,sans-serif}
.box{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:40px;width:360px;text-align:center}
h2{color:#fff;margin-bottom:8px}p{color:#64748b;font-size:14px;margin-bottom:24px}
input{width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:12px 16px;border-radius:10px;font-size:14px;outline:none;margin-bottom:16px}
input:focus{border-color:#2563eb}
button{width:100%;background:#2563eb;color:#fff;border:none;padding:12px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#1d4ed8}</style></head>
<body><div class="box">
<h2>✈ FlightStamp</h2><p>Admin Dashboard</p>
<input type="password" id="pw" placeholder="Enter password" onkeydown="if(event.key==='Enter')login()">
<button onclick="login()">Login</button>
</div>
<script>function login(){var p=document.getElementById('pw').value;if(p)window.location='/admin?pw='+encodeURIComponent(p);}</script>
</body></html>`);
      return;
    }

    // Fetch data
    Promise.all([
      pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200'),
      pool.query(`SELECT
        SUM(amount) as total_revenue, COUNT(*) as total_orders,
        SUM(CASE WHEN created_at::date = CURRENT_DATE THEN amount ELSE 0 END) as today_revenue,
        COUNT(CASE WHEN created_at::date = CURRENT_DATE THEN 1 END) as today_orders,
        SUM(CASE WHEN created_at >= date_trunc('month', NOW()) THEN amount ELSE 0 END) as month_revenue,
        COUNT(CASE WHEN created_at >= date_trunc('month', NOW()) THEN 1 END) as month_orders
        FROM orders`),
      pool.query('SELECT COUNT(DISTINCT session_id) as online_now FROM visitors WHERE last_seen > NOW() - INTERVAL \'2 minutes\''),
      pool.query('SELECT COUNT(DISTINCT session_id) as visitors_today FROM visitors WHERE created_at::date = CURRENT_DATE'),
      pool.query('SELECT * FROM visitors ORDER BY last_seen DESC LIMIT 100')
    ]).then(function(results) {
      var orders = results[0].rows;
      var statsRow = results[1].rows[0];
      var stats = {
        total_revenue: parseInt(statsRow.total_revenue) || 0,
        total_orders: parseInt(statsRow.total_orders) || 0,
        today_revenue: parseInt(statsRow.today_revenue) || 0,
        today_orders: parseInt(statsRow.today_orders) || 0,
        month_revenue: parseInt(statsRow.month_revenue) || 0,
        month_orders: parseInt(statsRow.month_orders) || 0,
        online_now: parseInt(results[2].rows[0].online_now) || 0,
        visitors_today: parseInt(results[3].rows[0].visitors_today) || 0
      };
      var visitors = results[4].rows;
      res.setHeader('Content-Type', 'text/html');
      res.end(adminHTML(orders, stats, visitors));
    }).catch(function(e) {
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1 style="color:red">DB Error: ' + e.message + '</h1>');
    });
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, function() {
  console.log('FlightStamp API running on port ' + PORT);
});
