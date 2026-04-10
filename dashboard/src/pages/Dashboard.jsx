import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, formatUptime } from '../api.js';
import { useAuth } from '../App.jsx';

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
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {server.hostname}
                </div>
              )}
              <div className="server-card-meta">
                <span className="server-card-stat">
                  Processes: <strong>{server.process_count || 0}</strong>
                </span>
                <span className="server-card-stat">
                  Running: <strong style={{ color: 'var(--green)' }}>{server.running_count || 0}</strong>
                </span>
                {server.last_seen_at && (
                  <span className="server-card-stat">
                    Seen: <strong>{formatUptime(server.last_seen_at)} ago</strong>
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
