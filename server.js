import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_FILE = path.join(process.cwd(), ".env");

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const INTERFACE = process.env.INTERFACE || "any";
const API_KEY = process.env.API_KEY || "";
const HISTORY_HOURS = Number(process.env.HISTORY_HOURS || 24);
const MAX_SOURCES = Number(process.env.MAX_SOURCES || 10000);
const MAX_DESTINATIONS = Number(process.env.MAX_DESTINATIONS || 10000);
const MAX_FLOWS = Number(process.env.MAX_FLOWS || 20000);
const MAX_PORTS = Number(process.env.MAX_PORTS || 1000);

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const startedAt = Date.now();
const sources = new Map();
const destinations = new Map();
const ports = new Map();
const flows = new Map();
const history = [];
const alerts = [];
let packetsRead = 0;
let tcpdumpRestarts = 0;
let rxBytes = 0;
let txBytes = 0;
let totalBytes = 0;
let totalPackets = 0;
let lastMinuteBytes = 0;
let previousMinuteBytes = 0;
let currentMinuteBytes = 0;
let minuteStarted = Date.now();
let tcpdumpProcess = null;

function localAddresses() {
  const out = new Set(["127.0.0.1", "::1"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.address) out.add(n.address);
  }
  return out;
}

let local = localAddresses();
setInterval(() => { local = localAddresses(); }, 30000).unref();

function isLocal(ip) {
  return local.has(ip);
}

function inc(map, key, value, extra = {}) {
  if (!key) return;
  const old = map.get(key) || { key, packets: 0, bytes: 0, firstSeen: Date.now(), lastSeen: Date.now(), ...extra };
  old.packets += 1;
  old.bytes += value;
  old.lastSeen = Date.now();
  map.set(key, old);
}

function trimMap(map, max) {
  if (map.size <= max) return;
  const entries = [...map.values()].sort((a, b) => b.bytes - a.bytes).slice(0, max);
  map.clear();
  for (const x of entries) map.set(x.key, x);
}

function normalizeIPv6(s) {
  return s.replace(/^\[|\]$/g, "");
}

function parseEndpoint(s) {
  s = s.trim().replace(/:$/g, "");
  if (s.startsWith("[")) {
    const end = s.lastIndexOf("]");
    if (end >= 0) {
      const ip = normalizeIPv6(s.slice(1, end));
      const port = Number(s.slice(end + 1).replace(/^:/, ""));
      return { ip, port: Number.isFinite(port) ? port : null };
    }
  }

  const lastColon = s.lastIndexOf(":");
  if (lastColon > -1) {
    const tail = s.slice(lastColon + 1);
    if (/^\d+$/.test(tail)) {
      return { ip: s.slice(0, lastColon), port: Number(tail) };
    }
  }
  return { ip: normalizeIPv6(s), port: null };
}

function parseLine(line) {
  const m = line.match(/^(?:\d+\.\d+\s+)?\S+\s+(In|Out)\s+(IP6?|IP)\s+(.+)$/);
  if (!m) return null;

  const direction = m[1] === "In" ? "in" : "out";
  const ipVersion = m[2] === "IP6" ? 6 : 4;
  const body = m[3];

  const endpoints = body.match(/^(.+?)\s+>\s+(.+?):\s+(.*)$/);
  if (!endpoints) return null;

  const src = parseEndpoint(endpoints[1]);
  const dst = parseEndpoint(endpoints[2]);
  if (!src.ip || !dst.ip) return null;

  const payload = endpoints[3];
  const lm = payload.match(/(?:^|,\s*)length\s+(\d+)/);
  const bytes = lm ? Number(lm[1]) : 0;

  let protocol = "OTHER";
  if (/\bUDP\b/i.test(payload)) protocol = "UDP";
  else if (/\bTCP\b|Flags\s*\[/i.test(payload)) protocol = "TCP";
  else if (/\bICMPv6?\b/i.test(payload)) protocol = ipVersion === 6 ? "ICMPv6" : "ICMP";

  return { direction, ipVersion, src, dst, protocol, bytes };
}

function processPacket(packet) {
  packetsRead++;
  totalPackets++;
  totalBytes += packet.bytes;
  currentMinuteBytes += packet.bytes;

  if (packet.direction === "in") rxBytes += packet.bytes;
  else txBytes += packet.bytes;

  inc(sources, packet.src.ip, packet.bytes, { ip: packet.src.ip });
  inc(destinations, packet.dst.ip, packet.bytes, { ip: packet.dst.ip });

  if (packet.src.port != null) inc(ports, String(packet.src.port), packet.bytes, { port: packet.src.port });
  if (packet.dst.port != null) inc(ports, String(packet.dst.port), packet.bytes, { port: packet.dst.port });

  const flowKey = [
    packet.src.ip,
    packet.src.port ?? "-",
    packet.dst.ip,
    packet.dst.port ?? "-",
    packet.protocol
  ].join("|");

  inc(flows, flowKey, packet.bytes, {
    source: packet.src.ip,
    sourcePort: packet.src.port,
    destination: packet.dst.ip,
    destinationPort: packet.dst.port,
    protocol: packet.protocol,
    direction: packet.direction
  });

  trimMap(sources, MAX_SOURCES);
  trimMap(destinations, MAX_DESTINATIONS);
  trimMap(ports, MAX_PORTS);
  trimMap(flows, MAX_FLOWS);
}

function startTcpdump() {
  if (tcpdumpProcess) return;
  console.log("[TCPDUMP] Starting on", INTERFACE);

  tcpdumpProcess = spawn("tcpdump", [
    "-nn", "-l", "-q", "-tt", "-i", INTERFACE, "ip or ip6"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  tcpdumpProcess.stdout.setEncoding("utf8");
  tcpdumpProcess.stdout.on("data", chunk => {
    for (const line of chunk.split(/\r?\n/)) {
      const p = parseLine(line);
      if (p) processPacket(p);
    }
  });

  tcpdumpProcess.stderr.setEncoding("utf8");
  tcpdumpProcess.stderr.on("data", data => {
    const s = data.trim();
    if (s) console.log("[TCPDUMP]", s);
  });

  tcpdumpProcess.on("exit", () => {
    tcpdumpProcess = null;
    tcpdumpRestarts++;
    setTimeout(startTcpdump, 3000).unref();
  });
}

function auth(req, res, next) {
  if (!API_KEY) return res.status(500).json({ success: false, error: "API_KEY not configured" });
  const supplied = req.get("X-API-Key") || (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (supplied !== API_KEY) return res.status(401).json({ success: false, error: "Unauthorized" });
  next();
}

function top(map, mapper, limit = 50) {
  return [...map.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit).map(mapper);
}

setInterval(() => {
  const now = Date.now();
  if (now - minuteStarted < 60000) return;

  previousMinuteBytes = lastMinuteBytes;
  lastMinuteBytes = currentMinuteBytes;

  history.push({
    timestamp: new Date(now).toISOString(),
    bytes: currentMinuteBytes,
    packets: totalPackets,
    rxBytes,
    txBytes
  });

  while (history.length > HISTORY_HOURS * 60) history.shift();

  if (previousMinuteBytes > 0 && currentMinuteBytes > previousMinuteBytes * 5) {
    alerts.unshift({
      type: "traffic_spike",
      timestamp: new Date(now).toISOString(),
      bytes: currentMinuteBytes,
      previousBytes: previousMinuteBytes
    });
    alerts.splice(100);
  }

  currentMinuteBytes = 0;
  minuteStarted = now;

  try {
    fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), "data", "history.json"),
      JSON.stringify(history)
    );
  } catch {}
}, 1000);

app.get("/health", (_req, res) => res.json({
  success: true,
  status: "online",
  service: "craftpick-traffic-monitor",
  version: "2.1.0",
  hostname: os.hostname(),
  uptime: process.uptime(),
  tcpdump: Boolean(tcpdumpProcess),
  timestamp: new Date().toISOString()
}));

app.get("/api/v2", auth, (_req, res) => res.json({
  success: true,
  version: "2.1.0",
  endpoints: [
    "/api/v2/status",
    "/api/v2/global",
    "/api/v2/traffic",
    "/api/v2/sources",
    "/api/v2/destinations",
    "/api/v2/ports",
    "/api/v2/flows",
    "/api/v2/history",
    "/api/v2/alerts"
  ]
}));

app.get("/api/v2/status", auth, (_req, res) => res.json({
  success: true,
  monitor: {
    version: "2.1.0",
    uptime: process.uptime(),
    startedAt: new Date(startedAt).toISOString(),
    interface: INTERFACE,
    tcpdump: {
      running: Boolean(tcpdumpProcess),
      packetsRead,
      restarts: tcpdumpRestarts
    },
    localAddresses: [...local],
    totals: { packets: totalPackets, bytes: totalBytes, rxBytes, txBytes },
    memory: {
      sources: sources.size,
      destinations: destinations.size,
      ports: ports.size,
      flows: flows.size,
      history: history.length
    }
  }
}));

app.get("/api/v2/global", auth, (_req, res) => res.json({
  success: true,
  totalPackets,
  totalBytes,
  rxBytes,
  txBytes,
  currentMinuteBytes,
  sources: top(sources, x => x, 100),
  destinations: top(destinations, x => x, 100),
  flows: top(flows, x => x, 100)
}));

app.get("/api/v2/traffic", auth, (_req, res) => res.json({
  success: true,
  totalPackets,
  totalBytes,
  rxBytes,
  txBytes,
  currentMinuteBytes,
  packetsRead,
  currentRateBytes: currentMinuteBytes / Math.max(1, (Date.now() - minuteStarted) / 1000)
}));

app.get("/api/v2/sources", auth, (req, res) => res.json({
  success: true,
  items: top(sources, x => x, Number(req.query.limit || 100))
}));

app.get("/api/v2/destinations", auth, (req, res) => res.json({
  success: true,
  items: top(destinations, x => x, Number(req.query.limit || 100))
}));

app.get("/api/v2/ports", auth, (req, res) => res.json({
  success: true,
  items: top(ports, x => x, Number(req.query.limit || 100))
}));

app.get("/api/v2/flows", auth, (req, res) => res.json({
  success: true,
  items: top(flows, x => x, Number(req.query.limit || 100))
}));

app.get("/api/v2/history", auth, (_req, res) => res.json({ success: true, items: history }));

app.get("/api/v2/alerts", auth, (_req, res) => res.json({ success: true, items: alerts }));

app.listen(PORT, HOST, () => {
  console.log("======================================");
  console.log(" Craftpick Traffic Monitor V2.1.0");
  console.log("======================================");
  console.log(`Listening: http://${HOST}:${PORT}`);
  console.log(`Interface: ${INTERFACE}`);
  startTcpdump();
});