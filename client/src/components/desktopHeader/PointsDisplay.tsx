import React from 'react';
import AnimatedNumber from '../AnimatedNumber';

interface PointsDisplayProps {
  userPoints: number;
}

const PointsDisplay: React.FC<PointsDisplayProps> = ({ userPoints }) => (
  <div className="points-display-modern points-counter">
    <div className="points-glow"></div>
    <div className="points-inner">
      <div className="points-icon-modern">
        <span className="gem-icon">💎</span>
        <div className="gem-sparkle sparkle-1"></div>
        <div className="gem-sparkle sparkle-2"></div>
        <div className="gem-sparkle sparkle-3"></div>
      </div>
      <div className="points-value-wrapper">
        <AnimatedNumber value={userPoints} />
        <span className="points-suffix">Points</span>
      </div>
    </div>
  </div>
);

export default PointsDisplay;
