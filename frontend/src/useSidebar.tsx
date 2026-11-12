/**
 * 사이드바 너비·접힘·드래그 상태 관리. 화면 폭에 따라 최대 너비를 제한하고 접기 전 너비를 기억한다.
 * 포인터 캡처와 키보드 조작을 함께 지원한다.
 */
import { useEffect, useRef, useState } from 'react';

const collapsedWidth = 8,
  minWidth = 120;
export function useSidebar() {
  const [viewport, setViewport] = useState(window.innerWidth);
  const [expandedWidth, setExpandedWidth] = useState(() => (window.innerWidth <= 700 ? 150 : 220));
  const [collapsed, setCollapsed] = useState(false),
    [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const maxWidth = Math.max(minWidth, Math.min(600, viewport - 280));
  const clamp = (width: number) => Math.max(minWidth, Math.min(maxWidth, width));
  const width = collapsed ? collapsedWidth : clamp(expandedWidth);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  function toggle() {
    setCollapsed((value) => !value);
  }
  const handle = (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-label="사이드메뉴 너비"
      aria-orientation="vertical"
      aria-controls="sidebar-menu"
      aria-valuemin={collapsedWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={Math.round(width)}
      aria-valuetext={collapsed ? '접힘' : Math.round(width) + '픽셀'}
      tabIndex={0}
      title="드래그: 너비 조절 · 더블클릭 또는 Enter: 접기/복원"
      onDoubleClick={toggle}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        if (!drag.current || Math.abs(e.clientX - drag.current.x) < 3) return;
        setDragging(true);
        setCollapsed(false);
        setExpandedWidth(clamp(drag.current.width + e.clientX - drag.current.x));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        setDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        } else if (e.key === 'Home') {
          e.preventDefault();
          setCollapsed(true);
        } else if (e.key === 'End') {
          e.preventDefault();
          setCollapsed(false);
          setExpandedWidth(maxWidth);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          setCollapsed(false);
          setExpandedWidth(clamp(width + (e.key === 'ArrowLeft' ? -20 : 20)));
        }
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
  return { width, collapsed, dragging, handle };
}
