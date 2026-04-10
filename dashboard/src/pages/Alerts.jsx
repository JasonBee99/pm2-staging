import React, { useState, useEffect, useCallback } from 'react';
import { api, formatDateTime } from '../api.js';
import { useAuth } from '../App.jsx';

export default function Alerts() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState([]);
  const [servers, setServers] = useState([]);
  const [processes, setProcesses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    server_id: '', process_id: '', condition_type: 'crash',
    threshold_value: '', channel: 'webhook', target: '', cooldown_minutes: 15,
  });

  const fetchAlerts = useCallback(async () => {
    try {
      const data = await api.get('/api/alerts');
      setAlerts(data.alerts);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
    api.get('/api/servers').then(d => setServers(d.servers)).catch(() => {});
  }, [fetchAlerts]);

  // When server is selected, load its processes
  useEffect(() => {
    if (form.server_id) {
      api.get(`/api/servers/${form.server_id}/processes`)
        .then(d => setProcesses(d.processes))
        .catch(() => setProcesses([]));
    } else {
      setProcesses([]);
    }
  }, [form.server_id]);

  const handleAdd = async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/alerts', {
        ...form,
        server_id: form.server_id || null,
        process_id: form.process_id || null,
        threshold_value: form.threshold_value ? parseInt(form.threshold_value) : null,
      });
      setShowAdd(false);
      setForm({ server_id: '', process_id: '', condition_type: 'crash', threshold_value: '', channel: 'webhook', target: '', cooldown_minutes: 15 });
      fetchAlerts();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleToggle = async (id, enabled) => {
    await api.patch(`/api/alerts/${id}`, { enabled: !enabled });
    fetchAlerts();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this alert?')) return;
    await api.delete(`/api/alerts/${id}`);
    fetchAlerts();
  };

  const handleTest = async (id) => {
    try {
      const result = await api.post(`/api/alerts/${id}/test`);
      if (result.error) {
        alert(`Test failed: ${result.error}`);
      } else {
        alert('Test notification sent! Check your notification channel.');
      }
    } catch (err) {
      alert(err.message);
    }
  };

  const conditionLabels = {
    crash: 'Process Crash',
    restart_loop: 'Restart Loop',
    offline: 'Server Offline',
    cpu_above: 'CPU Above Threshold',
    mem_above: 'Memory Above Threshold',
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">Alerts</h1>
        {user?.role === 'admin' && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Alert</button>
        )}
      </div>

      <div className="card">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
        ) : alerts.length === 0 ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <div className="empty-state-icon">🔔</div>
            <div className="empty-state-text">No alerts configured yet.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Scope</th>
                  <th>Channel</th>
                  <th>Target</th>
                  <th>Cooldown</th>
                  <th>Last Triggered</th>
                  <th>Enabled</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map(alert => (
                  <tr key={alert.id} style={{ opacity: alert.enabled ? 1 : 0.5 }}>
                    <td>
                      <strong>{conditionLabels[alert.condition_type] || alert.condition_type}</strong>
                      {alert.threshold_value && (
                        <div className="mono" style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                          Threshold: {alert.condition_type === 'mem_above'
                            ? `${(alert.threshold_value / (1024 * 1024)).toFixed(0)} MB`
                            : `${alert.threshold_value}%`}
                        </div>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {alert.process_name || alert.server_name || 'All servers'}
                    </td>
                    <td><span className="badge" style={{ background: 'var(--bg-input)', color: 'var(--text-secondary)' }}>{alert.channel}</span></td>
                    <td className="mono" style={{ fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{alert.target}</td>
                    <td className="mono">{alert.cooldown_minutes}m</td>
                    <td className="mono">{alert.last_triggered_at ? formatDateTime(alert.last_triggered_at) : 'Never'}</td>
                    <td>
                      <button className={`btn btn-sm ${alert.enabled ? 'btn-success' : ''}`}
                        onClick={() => handleToggle(alert.id, alert.enabled)}>
                        {alert.enabled ? 'ON' : 'OFF'}
                      </button>
                    </td>
                    <td>
                      <div className="btn-group">
                        <button className="btn btn-sm" onClick={() => handleTest(alert.id)}>Test</button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDelete(alert.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Alert Modal */}
      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Add Alert</div>
            <form onSubmit={handleAdd}>
              <div className="form-group">
                <label className="form-label">Condition</label>
                <select className="form-select" value={form.condition_type}
                  onChange={(e) => setForm({ ...form, condition_type: e.target.value })}>
                  <option value="crash">Process Crash</option>
                  <option value="restart_loop">Restart Loop</option>
                  <option value="offline">Server Offline</option>
                  <option value="cpu_above">CPU Above Threshold</option>
                  <option value="mem_above">Memory Above Threshold</option>
                </select>
              </div>

              {(form.condition_type === 'cpu_above' || form.condition_type === 'mem_above') && (
                <div className="form-group">
                  <label className="form-label">
                    Threshold ({form.condition_type === 'cpu_above' ? '%' : 'MB'})
                  </label>
                  <input type="number" className="form-input" value={form.threshold_value}
                    onChange={(e) => setForm({ ...form, threshold_value: e.target.value })} required />
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Server (optional)</label>
                <select className="form-select" value={form.server_id}
                  onChange={(e) => setForm({ ...form, server_id: e.target.value, process_id: '' })}>
                  <option value="">All Servers</option>
                  {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              {form.server_id && processes.length > 0 && (
                <div className="form-group">
                  <label className="form-label">Process (optional)</label>
                  <select className="form-select" value={form.process_id}
                    onChange={(e) => setForm({ ...form, process_id: e.target.value })}>
                    <option value="">All Processes</option>
                    {processes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Notification Channel</label>
                <select className="form-select" value={form.channel}
                  onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                  <option value="webhook">Webhook</option>
                  <option value="discord">Discord</option>
                  <option value="email">Email</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Target (URL or Email)</label>
                <input className="form-input" value={form.target}
                  onChange={(e) => setForm({ ...form, target: e.target.value })}
                  placeholder={form.channel === 'email' ? 'you@example.com' : 'https://hooks.example.com/...'}
                  required />
              </div>

              <div className="form-group">
                <label className="form-label">Cooldown (minutes)</label>
                <input type="number" className="form-input" style={{ width: 100 }} value={form.cooldown_minutes}
                  onChange={(e) => setForm({ ...form, cooldown_minutes: parseInt(e.target.value) || 15 })} />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Create Alert</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
