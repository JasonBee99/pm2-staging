import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';
import { api, formatBytes, formatUptime, formatTime, formatDateTime } from '../api.js';

export default function ProcessDetail() {
  const { id } = useParams();
  const [proc, setProc] = useState(null);
  const [metrics, setMetrics] = useState([]);
  const [logs, setLogs] = useState([]);
  const [events, setEvents] = useState([]);
  const [activeTab, setActiveTab] = useState('metrics');
  const [metricsRange, setMetricsRange] = useState('1h');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null); // 'start' | 'stop' | 'restart' | null
  const [toast, setToast] = useState(null); // { message, type }
  const logEndRef = useRef(null);

  const fetchProcess = useCallback(async () => {
    try {
      const data = await api.get(`/api/processes/${id}`);
      setProc(data.process);
    } catch (err) {
      console.error(err);
    }
  }, [id]);

  const fetchMetrics = useCallback(async () => {
    try {
      const data = await api.get(`/api/processes/${id}/metrics?range=${metricsRange}`);
      setMetrics(data.metrics.map(m => ({
        ...m,
        time: new Date(m.time).getTime(),
        mem_mb: m.mem ? m.mem / (1024 * 1024) : 0,
      })));
    } catch (err) {
      console.error(err);
    }
  }, [id, metricsRange]);

  const fetchLogs = useCallback(async () => {
    try {
      const data = await api.get(`/api/processes/${id}/logs?limit=500`);
      setLogs(data.logs);
    } catch (err) {
      console.error(err);
    }
  }, [id]);

  const fetchEvents = useCallback(async () => {
    try {
      const data = await api.get(`/api/processes/${id}/events?limit=100`);
      setEvents(data.events);
    } catch (err) {
      console.error(err);
    }
  }, [id]);

  useEffect(() => {
    Promise.all([fetchProcess(), fetchMetrics(), fetchLogs(), fetchEvents()])
      .finally(() => setLoading(false));
  }, [fetchProcess, fetchMetrics, fetchLogs, fetchEvents]);

  // Refresh metrics on range change
  useEffect(() => { fetchMetrics(); }, [metricsRange, fetchMetrics]);

  // Periodic refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchProcess();
      if (activeTab === 'metrics') fetchMetrics();
      if (activeTab === 'logs') fetchLogs();
    }, 10000);
    return () => clearInterval(interval);
  }, [activeTab, fetchProcess, fetchMetrics, fetchLogs]);

  // Live updates via WS
  useEffect(() => {
    const handler = (e) => {
      const msg = e.detail;
      if (msg.type === 'metrics_tick' && msg.process_id === id) {
        setMetrics(prev => {
          const newPoint = {
            time: new Date(msg.time || Date.now()).getTime(),
            cpu: msg.cpu,
            mem: msg.mem,
            mem_mb: msg.mem ? msg.mem / (1024 * 1024) : 0,
          };
          const updated = [...prev, newPoint];
          // Keep last 500 points
          return updated.length > 500 ? updated.slice(-500) : updated;
        });
      }
      if (msg.type === 'log_line' && msg.process_id === id) {
        setLogs(prev => {
          const updated = [...prev, { time: msg.time, stream: msg.stream, line: msg.line }];
          return updated.length > 1000 ? updated.slice(-1000) : updated;
        });
      }
      if (msg.type === 'process_update' && msg.process?.id === id) {
        setProc(msg.process);
      }
    };
    window.addEventListener('ws-message', handler);
    return () => window.removeEventListener('ws-message', handler);
  }, [id]);

  // Auto-scroll logs
  useEffect(() => {
    if (activeTab === 'logs' && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, activeTab]);

  const showToast = (message, type = 'success', durationMs = 3500) => {
    setToast({ message, type });
    setTimeout(() => setToast(null), durationMs);
  };

  const pollForStatus = async (action) => {
    // Poll for up to 15 seconds, 2s intervals
    const maxAttempts = 8;
    let lastStatus = null;
    let consecutiveRunning = 0;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const data = await api.get(`/api/processes/${id}`);
        const p = data.process;
        setProc(p);
        lastStatus = p.status;

        if (action === 'stop') {
          if (p.status === 'stopped') {
            return { ok: true, message: 'Stopped successfully' };
          }
        } else {
          // start or restart — want to see 'running' stable
          if (p.status === 'running') {
            consecutiveRunning++;
            if (consecutiveRunning >= 2) {
              return { ok: true, message: `${action === 'restart' ? 'Restart' : 'Start'} successful — process is running` };
            }
          } else if (p.status === 'crashed') {
            return { ok: false, message: `${action === 'restart' ? 'Restart' : 'Start'} failed — process crashed. Check Events tab.` };
          } else {
            consecutiveRunning = 0;
          }
        }
      } catch (err) {
        // keep trying
      }
    }

    return { ok: null, message: `Still ${action === 'stop' ? 'stopping' : 'starting'} — status: ${lastStatus || 'unknown'}` };
  };

  const handleAction = async (action) => {
    if (actionLoading) return;
    setActionLoading(action);
    try {
      await api.post(`/api/processes/${id}/${action}`);
      showToast(`${action.charAt(0).toUpperCase() + action.slice(1)} command sent — verifying...`, 'info', 30000);

      // Refresh events so user sees the action recorded
      setTimeout(() => fetchEvents(), 1500);

      // Poll for confirmation
      const result = await pollForStatus(action);
      setActionLoading(null);

      if (result.ok === true) {
        showToast(result.message, 'success', 5000);
      } else if (result.ok === false) {
        showToast(result.message, 'error', 8000);
      } else {
        showToast(result.message, 'warning', 5000);
      }
      fetchEvents();
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
      setActionLoading(null);
    }
  };

  if (loading) return <div className="empty-state"><div className="empty-state-text">Loading...</div></div>;
  if (!proc) return <div className="empty-state"><div className="empty-state-text">Process not found</div></div>;

  const latestCpu = metrics.length > 0 ? metrics[metrics.length - 1].cpu : null;
  const latestMem = metrics.length > 0 ? metrics[metrics.length - 1].mem : null;

  const tooltipStyle = {
    backgroundColor: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
  };

  return (
    <div className="fade-in">
      <div className="page-breadcrumb">
        <Link to="/">Servers</Link> / <Link to={`/servers/${proc.server_id}`}>Server</Link> / {proc.name}
      </div>

      <div className="page-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {proc.name}
            <span className={`badge badge-${proc.status}`}>{proc.status}</span>
          </h1>
          <div className="mono" style={{ color: 'var(--text-muted)', marginTop: 4 }}>{proc.command}</div>
        </div>
        <div className="btn-group">
          {proc.status !== 'running' && (
            <button className="btn btn-success" onClick={() => handleAction('start')} disabled={!!actionLoading}>
              {actionLoading === 'start' ? '⟳ Starting...' : '▶ Start'}
            </button>
          )}
          {proc.status === 'running' && (
            <>
              <button className="btn" onClick={() => handleAction('restart')} disabled={!!actionLoading}>
                {actionLoading === 'restart' ? '⟳ Restarting...' : '↻ Restart'}
              </button>
              <button className="btn btn-danger" onClick={() => handleAction('stop')} disabled={!!actionLoading}>
                {actionLoading === 'stop' ? '⟳ Stopping...' : '■ Stop'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid-4" style={{ marginBottom: 24 }}>
        <div className="stat-box">
          <div className="stat-label">CPU</div>
          <div className="stat-value" style={{ color: latestCpu > 80 ? 'var(--red)' : latestCpu > 50 ? 'var(--yellow)' : 'var(--green)' }}>
            {latestCpu != null ? `${latestCpu.toFixed(1)}%` : '-'}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Memory</div>
          <div className="stat-value">{latestMem != null ? formatBytes(latestMem) : '-'}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Uptime</div>
          <div className="stat-value" style={{ fontSize: 20 }}>{formatUptime(proc.uptime_started_at)}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Restarts</div>
          <div className="stat-value" style={{ color: proc.restart_count > 5 ? 'var(--yellow)' : 'inherit' }}>
            {proc.restart_count}
          </div>
          <div className="stat-sub">PID: {proc.pid || '-'}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button className={`tab ${activeTab === 'metrics' ? 'active' : ''}`} onClick={() => setActiveTab('metrics')}>Metrics</button>
        <button className={`tab ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>Logs</button>
        <button className={`tab ${activeTab === 'events' ? 'active' : ''}`} onClick={() => setActiveTab('events')}>Events</button>
      </div>

      {/* Metrics Tab */}
      {activeTab === 'metrics' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            {['15m', '1h', '6h', '24h', '7d'].map(r => (
              <button key={r} className={`btn btn-sm ${metricsRange === r ? 'btn-primary' : ''}`} onClick={() => setMetricsRange(r)}>
                {r}
              </button>
            ))}
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-title" style={{ marginBottom: 12 }}>CPU Usage</div>
              <div style={{ width: '100%', height: 200 }}>
                <ResponsiveContainer>
                  <AreaChart data={metrics}>
                    <defs>
                      <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="time" tickFormatter={formatTime} stroke="#64748b" fontSize={10} />
                    <YAxis stroke="#64748b" fontSize={10} domain={[0, 'auto']} unit="%" />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(v) => new Date(v).toLocaleTimeString()}
                      formatter={(v) => [`${v?.toFixed(1)}%`, 'CPU']}
                    />
                    <Area type="monotone" dataKey="cpu" stroke="#3b82f6" fill="url(#cpuGrad)" strokeWidth={1.5} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card">
              <div className="card-title" style={{ marginBottom: 12 }}>Memory Usage</div>
              <div style={{ width: '100%', height: 200 }}>
                <ResponsiveContainer>
                  <AreaChart data={metrics}>
                    <defs>
                      <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="time" tickFormatter={formatTime} stroke="#64748b" fontSize={10} />
                    <YAxis stroke="#64748b" fontSize={10} domain={[0, 'auto']}
                      tickFormatter={(v) => `${v?.toFixed(0)} MB`} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(v) => new Date(v).toLocaleTimeString()}
                      formatter={(v) => [`${v?.toFixed(1)} MB`, 'Memory']}
                    />
                    <Area type="monotone" dataKey="mem_mb" stroke="#22c55e" fill="url(#memGrad)" strokeWidth={1.5} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Logs Tab */}
      {activeTab === 'logs' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Live Logs</span>
            <span className="card-subtitle">{logs.length} lines</span>
          </div>
          <div className="log-viewer">
            {logs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>No logs yet</div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className={`log-line log-line-${log.stream}`}>
                  <span className="log-time">{formatTime(log.time)}</span>
                  {log.line}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* Events Tab */}
      {activeTab === 'events' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Lifecycle Events</span>
          </div>
          {events.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>No events yet</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Exit Code</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map(evt => (
                    <tr key={evt.id}>
                      <td className="mono">{formatDateTime(evt.occurred_at)}</td>
                      <td><span className={`badge badge-${evt.kind === 'crash' ? 'crashed' : evt.kind === 'start' ? 'running' : 'stopped'}`}>{evt.kind}</span></td>
                      <td className="mono">{evt.exit_code != null ? evt.exit_code : '-'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {evt.message || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Toast */}
      {toast && (() => {
        const colors = {
          success: { bg: 'var(--green-dim)', icon: '✓' },
          error: { bg: 'var(--red-dim)', icon: '✗' },
          warning: { bg: 'var(--yellow-dim)', icon: '⚠' },
          info: { bg: 'var(--accent)', icon: '⟳' },
        };
        const c = colors[toast.type] || colors.info;
        return (
          <div className="toast-fade-in" style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: c.bg,
            color: '#fff',
            padding: '22px 34px',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 0 40px rgba(0,212,255,0.4), 0 10px 40px rgba(0,0,0,0.7)',
            fontSize: 16,
            fontWeight: 600,
            zIndex: 500,
            border: '3px solid #00d4ff',
            maxWidth: 500,
            textAlign: 'center',
            minWidth: 300,
          }}>
            <span style={{ marginRight: 10, fontSize: 20 }}>{c.icon}</span>{toast.message}
          </div>
        );
      })()}
    </div>
  );
}
