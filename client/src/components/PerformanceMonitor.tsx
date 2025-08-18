import React, { useState, useEffect, useRef } from 'react';
import { PerformanceMonitor, PerformanceMetrics, PerformanceAlert } from '../services/PerformanceMonitor';

interface PerformanceMonitorProps {
  peerConnection?: RTCPeerConnection | null;
  isActive: boolean;
  className?: string;
  showDetailed?: boolean;
}

const PerformanceMonitorComponent: React.FC<PerformanceMonitorProps> = ({
  peerConnection,
  isActive,
  className = '',
  showDetailed = false
}) => {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [alerts, setAlerts] = useState<PerformanceAlert[]>([]);
  const [quality, setQuality] = useState<'excellent' | 'good' | 'poor' | 'critical'>('good');
  const [isExpanded, setIsExpanded] = useState(false);
  const performanceMonitorRef = useRef<PerformanceMonitor | null>(null);

  useEffect(() => {
    if (!performanceMonitorRef.current) {
      performanceMonitorRef.current = new PerformanceMonitor();
    }

    const monitor = performanceMonitorRef.current;

    if (isActive) {
      monitor.setCallbacks({
        onMetricsUpdate: (newMetrics) => {
          setMetrics(newMetrics);
        },
        onAlert: (alert) => {
          setAlerts(prev => [...prev.slice(-9), alert]); // Keep last 10 alerts
        },
        onQualityChange: (newQuality) => {
          setQuality(newQuality);
        }
      });

      monitor.startMonitoring(peerConnection || undefined);
    } else {
      monitor.stopMonitoring();
      setMetrics(null);
      setAlerts([]);
    }

    return () => {
      monitor.stopMonitoring();
    };
  }, [isActive, peerConnection]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatBitrate = (bps: number): string => {
    if (bps === 0) return '0 bps';
    const k = 1000;
    const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps'];
    const i = Math.floor(Math.log(bps) / Math.log(k));
    return parseFloat((bps / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const getQualityColor = (quality: string): string => {
    switch (quality) {
      case 'excellent': return '#4CAF50';
      case 'good': return '#8BC34A';
      case 'poor': return '#FF9800';
      case 'critical': return '#F44336';
      default: return '#757575';
    }
  };

  const getQualityIcon = (quality: string): string => {
    switch (quality) {
      case 'excellent': return '🟢';
      case 'good': return '🟡';
      case 'poor': return '🟠';
      case 'critical': return '🔴';
      default: return '⚪';
    }
  };

  if (!isActive || !metrics) {
    return null;
  }

  return (
    <div className={`performance-monitor ${className}`} style={{
      position: 'fixed',
      top: '10px',
      right: '10px',
      background: 'rgba(0, 0, 0, 0.8)',
      color: 'white',
      borderRadius: '8px',
      padding: isExpanded ? '15px' : '8px',
      minWidth: isExpanded ? '300px' : '120px',
      fontSize: '12px',
      fontFamily: 'monospace',
      zIndex: 1000,
      border: `2px solid ${getQualityColor(quality)}`,
      transition: 'all 0.3s ease'
    }}>
      {/* Compact View Header */}
      <div 
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          cursor: 'pointer',
          marginBottom: isExpanded ? '10px' : '0'
        }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          {getQualityIcon(quality)}
          <strong>{quality.toUpperCase()}</strong>
        </span>
        <span style={{ fontSize: '10px' }}>
          {isExpanded ? '▼' : '▶'}
        </span>
      </div>

      {/* Compact Metrics */}
      {!isExpanded && (
        <div style={{ fontSize: '10px', opacity: 0.8 }}>
          <div>{metrics.connection.latency.toFixed(0)}ms</div>
          <div>{metrics.video.frameRate.toFixed(0)}fps</div>
        </div>
      )}

      {/* Expanded Detailed View */}
      {isExpanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* Recent Alerts */}
          {alerts.length > 0 && (
            <div style={{ 
              background: 'rgba(244, 67, 54, 0.2)', 
              padding: '5px', 
              borderRadius: '4px',
              maxHeight: '60px',
              overflowY: 'auto'
            }}>
              <div style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '3px' }}>
                ⚠️ Recent Alerts
              </div>
              {alerts.slice(-2).map((alert, index) => (
                <div key={index} style={{ fontSize: '10px', opacity: 0.9 }}>
                  {alert.message}
                </div>
              ))}
            </div>
          )}

          {/* Connection Metrics */}
          <div>
            <div style={{ fontWeight: 'bold', marginBottom: '3px' }}>🔗 Connection</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', fontSize: '10px' }}>
              <div>Latency: {metrics.connection.latency.toFixed(0)}ms</div>
              <div>Jitter: {metrics.connection.jitter.toFixed(1)}ms</div>
              <div>Loss: {metrics.connection.packetLoss.toFixed(1)}%</div>
              <div>↓ {formatBitrate(metrics.connection.bandwidth.down)}</div>
            </div>
          </div>

          {/* Video Metrics */}
          <div>
            <div style={{ fontWeight: 'bold', marginBottom: '3px' }}>📺 Video</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', fontSize: '10px' }}>
              <div>FPS: {metrics.video.frameRate.toFixed(0)}</div>
              <div>{formatBitrate(metrics.video.bitrate)}</div>
              <div>{metrics.video.resolution.width}×{metrics.video.resolution.height}</div>
              <div>Drop: {metrics.video.framesDropped}</div>
            </div>
          </div>

          {/* Audio Metrics */}
          <div>
            <div style={{ fontWeight: 'bold', marginBottom: '3px' }}>🔊 Audio</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', fontSize: '10px' }}>
              <div>{formatBitrate(metrics.audio.bitrate)}</div>
              <div>Level: {(metrics.audio.audioLevel * 100).toFixed(0)}%</div>
              <div>Buffer: {(metrics.audio.jitterBuffer * 1000).toFixed(0)}ms</div>
              <div>Rate: {(metrics.audio.sampleRate / 1000).toFixed(0)}kHz</div>
            </div>
          </div>

          {/* System Metrics */}
          <div>
            <div style={{ fontWeight: 'bold', marginBottom: '3px' }}>💻 System</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', fontSize: '10px' }}>
              <div>CPU: {metrics.system.cpuUsage.toFixed(0)}%</div>
              <div>RAM: {metrics.system.memoryUsage.toFixed(0)}%</div>
              <div>Net: {metrics.system.networkType}</div>
              {metrics.system.batteryLevel && (
                <div>🔋 {metrics.system.batteryLevel}%</div>
              )}
            </div>
          </div>

          {/* Detailed Mode Toggle */}
          {showDetailed && (
            <div style={{ 
              borderTop: '1px solid rgba(255,255,255,0.2)', 
              paddingTop: '8px',
              fontSize: '10px'
            }}>
              <div>Frames Decoded: {metrics.video.framesDecoded}</div>
              <div>Audio Jitter Buffer: {(metrics.audio.jitterBuffer * 1000).toFixed(1)}ms</div>
              <div>Bandwidth Up: {formatBitrate(metrics.connection.bandwidth.up)}</div>
            </div>
          )}

          {/* Quality Indicator Bar */}
          <div style={{ 
            height: '4px', 
            background: getQualityColor(quality), 
            borderRadius: '2px',
            marginTop: '5px'
          }} />
        </div>
      )}
    </div>
  );
};

export default PerformanceMonitorComponent;