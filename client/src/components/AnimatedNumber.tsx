import React, { useEffect, useState, useRef } from 'react';

interface AnimatedNumberProps {
  value: number;
  duration?: number; // Animation duration in ms
  formatNumber?: boolean; // Whether to format with commas
}

const AnimatedNumber: React.FC<AnimatedNumberProps> = ({ 
  value, 
  duration = 500,
  formatNumber = true 
}) => {
  const [displayValue, setDisplayValue] = useState(value);
  const [isAnimating, setIsAnimating] = useState(false);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    // Cancel any ongoing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    const startValue = displayValue;
    const endValue = value;
    const difference = endValue - startValue;
    
    // If no difference, don't animate
    if (difference === 0) {
      return;
    }

    const startTime = Date.now();
    setIsAnimating(true);

    const animateValue = () => {
      const now = Date.now();
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Use easing function for smooth animation
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
      const easedProgress = easeOutCubic(progress);
      
      const currentValue = Math.round(startValue + (difference * easedProgress));
      setDisplayValue(currentValue);
      
      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animateValue);
      } else {
        setDisplayValue(value);
        setIsAnimating(false);
        animationRef.current = null;
      }
    };

    animationRef.current = requestAnimationFrame(animateValue);

    // Cleanup function
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);

  return (
    <span className={`animated-number ${isAnimating ? 'animating' : ''}`}>
      {formatNumber ? displayValue.toLocaleString() : displayValue}
    </span>
  );
};

export default AnimatedNumber;