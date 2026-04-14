import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, formatUptime, formatBytes } from '../api.js';
import { useAuth } from '../App.jsx';

function formatSeconds(s) {
  if (!s) return '-';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const COLOR_MAP = {
  cyan: '#06b6d4',
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  purple: '#a855f7',
};

function MetricBar({ label, value, max, unit, color, display }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const c = COLOR_MAP[color] || COLOR_MAP.cyan;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginBottom: 3, letterSpacing: '0.5px' }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ color: 'var(--text-secondary)' }}>{display || `${value.toFixed(1)}${unit}`}</span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`,
          height: '100%',
          background: c,
          boxShadow: `0 0 6px ${c}80`,
          transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [addResult, setAddResult] = useState(null);

  const fetchServers = useCallback(async () => {
    try {
      const data = await api.get('/api/servers');
      setServers(data.servers);
    } catch (err) {
      console.error('Failed to fetch servers:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
    const interval = setInterval(fetchServers, 10000);
    return () => clearInterval(interval);
  }, [fetchServers]);

  // Listen for WS server status changes
  useEffect(() => {
    const handler = (e) => {
      const msg = e.detail;
      if (msg.type === 'server_status') {
        setServers(prev => prev.map(s =>
          s.id === msg.server_id ? { ...s, status: msg.status } : s
        ));
      }
    };
    window.addEventListener('ws-message', handler);
    return () => window.removeEventListener('ws-message', handler);
  }, []);

  const handleAddServer = async (e) => {
    e.preventDefault();
    try {
      const data = await api.post('/api/servers', { name: newServerName });
      setAddResult(data.server);
      fetchServers();
      setNewServerName('');
    } catch (err) {
      alert(err.message);
    }
  };

  const totalProcesses = servers.reduce((a, s) => a + (s.process_count || 0), 0);
  const totalRunning = servers.reduce((a, s) => a + (s.running_count || 0), 0);
  const onlineServers = servers.filter(s => s.status === 'online').length;

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Servers</h1>
        </div>
        {user?.role === 'admin' && (
          <button className="btn btn-primary" onClick={() => { setShowAddModal(true); setAddResult(null); }}>
            + Add Server
          </button>
        )}
      </div>

      {/* Stats row */}
      <div className="grid-4" style={{ marginBottom: 24 }}>
        <div className="stat-box">
          <div className="stat-label">Servers</div>
          <div className="stat-value">{servers.length}</div>
          <div className="stat-sub">{onlineServers} online</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Processes</div>
          <div className="stat-value">{totalProcesses}</div>
          <div className="stat-sub">{totalRunning} running</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Online</div>
          <div className="stat-value" style={{ color: 'var(--green)' }}>
            {servers.length > 0 ? Math.round((onlineServers / servers.length) * 100) : 0}%
          </div>
          <div className="stat-sub">uptime</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Status</div>
          <div className="stat-value" style={{ fontSize: 20 }}>
            {onlineServers === servers.length && servers.length > 0 ? (
              <span style={{ color: 'var(--green)' }}>All Clear</span>
            ) : servers.length === 0 ? (
              <span style={{ color: 'var(--text-muted)' }}>No Servers</span>
            ) : (
              <span style={{ color: 'var(--yellow)' }}>Degraded</span>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="empty-state"><div className="empty-state-text">Loading servers...</div></div>
      ) : servers.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📡</div>
          <div className="empty-state-text">No servers yet. Add one to get started.</div>
        </div>
      ) : (
        <div className="grid-3">
          {servers.map(server => (
            <Link key={server.id} to={`/servers/${server.id}`} className="server-card">
              <div className="server-card-header">
                <span className="server-card-name">{server.name}</span>
                <span className={`badge badge-${server.status}`}>{server.status}</span>
              </div>
              {server.hostname && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: 10 }}>
                  {server.hostname}
                </div>
              )}

              {/* System metrics bars */}
              {server.cpu_pct != null && (
                <div style={{ marginBottom: 12, marginTop: 4 }}>
                  <MetricBar label="CPU" value={server.cpu_pct} max={100} unit="%" color={server.cpu_pct > 80 ? 'red' : server.cpu_pct > 50 ? 'yellow' : 'cyan'} />
                  {server.mem_total_bytes > 0 && (
                    <MetricBar
                      label="RAM"
                      value={(server.mem_used_bytes / server.mem_total_bytes) * 100}
                      max={100}
                      unit=""
                      color="green"
                      display={`${formatBytes(server.mem_used_bytes)} / ${formatBytes(server.mem_total_bytes)}`}
                    />
                  )}
                  {server.disk_total_bytes > 0 && (
                    <MetricBar
                      label="DISK"
                      value={(server.disk_used_bytes / server.disk_total_bytes) * 100}
                      max={100}
                      unit=""
                      color="purple"
                      display={`${formatBytes(server.disk_used_bytes)} / ${formatBytes(server.disk_total_bytes)}`}
                    />
                  )}
                </div>
              )}

              <div className="server-card-meta">
                <span className="server-card-stat">
                  <strong>{server.running_count || 0}</strong>/{server.process_count || 0} procs
                </span>
                {server.load_1min != null && (
                  <span className="server-card-stat">
                    Load: <strong>{server.load_1min.toFixed(2)}</strong>
                  </span>
                )}
                {server.uptime_seconds > 0 && (
                  <span className="server-card-stat">
                    Up: <strong>{formatSeconds(server.uptime_seconds)}</strong>
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Add Server Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Add Server</div>

            {addResult ? (
              <div>
                <p style={{ marginBottom: 16 }}>Server <strong>{addResult.name}</strong> created. Copy this agent token into the agent config on your monitored VPS:</p>
                <div style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '12px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  wordBreak: 'break-all',
                  userSelect: 'all',
                  marginBottom: 16,
                }}>
                  {addResult.agent_token}
                </div>
                <div className="modal-actions">
                  <button className="btn" onClick={() => {
                    navigator.clipboard?.writeText(addResult.agent_token);
                  }}>Copy Token</button>
                  <button className="btn btn-primary" onClick={() => setShowAddModal(false)}>Done</button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleAddServer}>
                <div className="form-group">
                  <label className="form-label">Server Name</label>
                  <input
                    type="text"
                    className="form-input"
                    value={newServerName}
                    onChange={(e) => setNewServerName(e.target.value)}
                    placeholder="web-prod-1"
                    required
                    autoFocus
                  />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setShowAddModal(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Create Server</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
