/**
 * React 진입점과 업무 창틀. 로그인·메뉴 트리·탭·공통 툴바를 관리한다.
 * 탭은 메뉴와 화면 ID 조합으로 식별하여 메뉴별 권한을 구분한다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { AuditScreen } from './AuditScreen';
import { RegistrationScreen } from './RegistrationScreen';
import { AccountsScreen } from './AccountsScreen';
import { CustomersScreen } from './CustomersScreen';
import { SignupScreen } from './SignupScreen';
import { RecoveryScreen, RecoveryLink } from './RecoveryScreen';
import { sourceModules, buttonLabel } from './sourceModules';
import { actions, Nav, Screen, ScreenHandle, Tab, tabKey, User, ViewState } from './types';
import './style.css';
import { useToasts } from './Toasts';
import { useSidebar } from './useSidebar';
const emptyNav: Nav = { rootMenuId: '', menus: [], edges: [], screens: [] };
// 너비 우선 탐색으로 시작 메뉴부터 대상까지 첫 경로를 찾고 방문 집합으로 중복 탐색을 막는다.
function pathFor(n: Nav, id: string) {
  const queue = [[n.rootMenuId]],
    seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i],
      last = p.at(-1)!;
    if (last === id) return p;
    if (seen.has(last)) continue;
    seen.add(last);
    for (const e of n.edges.filter((e) => e.parent_menu_id === last))
      queue.push([...p, e.child_menu_id]);
  }
  return [];
}
// 숨김 연결은 표시하지 않는다. 현재 경로의 메뉴로 다시 내려가지 않아 재귀 순환을 방지한다.
function Branch({
  n,
  id,
  path,
  active,
  open,
}: {
  n: Nav;
  id: string;
  path: string[];
  active: string;
  open: (s: Screen, p: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(path.length === 1);
  const menu = n.menus.find((m) => m.id === id);
  const entries = [
    ...n.screens
      .filter((s) => s.menu_id === id && !s.hidden)
      .map((s) => ({ order: s.sort_order || 0, key: 'F' + s.id, screen: s, edge: null })),
    ...n.edges
      .filter((e) => e.parent_menu_id === id && !e.hidden && !path.includes(e.child_menu_id))
      .map((e) => ({ order: e.sort_order, key: 'M' + e.child_menu_id, screen: null, edge: e })),
  ].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  return menu ? (
    <div className="tree-branch">
      <button className="folder" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? '▾' : '▸'} {menu.name}
      </button>
      {expanded && (
        <div className="tree-children">
          {entries.map((e) =>
            e.screen ? (
              <button
                className={active === tabKey(e.screen) ? 'selected' : ''}
                key={e.key}
                onClick={() => open(e.screen!, path)}
              >
                {e.screen.name}
              </button>
            ) : (
              <Branch
                key={e.key}
                n={n}
                id={e.edge!.child_menu_id}
                path={[...path, e.edge!.child_menu_id]}
                active={active}
                open={open}
              />
            ),
          )}
        </div>
      )}
    </div>
  ) : null;
}
function App() {
  const customerCode = new URLSearchParams(window.location.search).get('customer') || '';
  const [signup, setSignup] = useState(false);
  // 링크의 비밀값은 주소창에서 즉시 제거하고 이 화면의 메모리에만 유지한다.
  const [recoveryLink, setRecoveryLink] = useState<RecoveryLink | null>(() => {
    const match = /^#account=(VERIFY|PASSWORD):([a-f0-9]{64})$/.exec(window.location.hash);
    if (!match) return null;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return { purpose: match[1] as RecoveryLink['purpose'], token: match[2] };
  });
  const [recovering, setRecovering] = useState(false);
  const { notify, clear, viewport: toasts } = useToasts();
  const sidebar = useSidebar();
  const [user, setUser] = useState<User | null>(null),
    [busy, setBusy] = useState(true);
  const [nav, setNav] = useState<Nav>(emptyNav),
    [tabs, setTabs] = useState<Tab[]>([]),
    [active, setActive] = useState('');
  const [states, setStates] = useState<Record<string, ViewState>>({}),
    [context, setContext] = useState<{ x: number; y: number; key: string } | null>(null);
  const [running, setRunning] = useState(false);
  const handles = useRef(new Map<string, ScreenHandle>());
  const current = tabs.find((t) => tabKey(t) === active);
  useEffect(() => {
    if (!context) return;
    const dismiss = () => setContext(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', key);
    };
  }, [context]);
  const markState = useCallback(
    (k: string, s: ViewState) =>
      setStates((v) => (JSON.stringify(v[k]) === JSON.stringify(s) ? v : { ...v, [k]: s })),
    [],
  );
  // 탭 식별자만 복원하며 편집 데이터는 복원하지 않는다. 최신 서버 목록에 남은 화면만 연다.
  async function initialize(u: User) {
    const stored = sessionStorage.getItem('tabs:' + u.id) || '{}';
    if (!u.mustChangePassword) {
      const n: Nav = await api('navigation');
      setNav(n);
      try {
        const saved = JSON.parse(stored),
          keys: string[] = Array.isArray(saved.keys) ? saved.keys : [];
        const opened = keys
          .map((k) => n.screens.find((s) => tabKey(s) === k))
          .filter((s): s is Screen => Boolean(s))
          .map((s) => ({ ...s, path: pathFor(n, s.menu_id) }));
        setTabs(opened);
        setActive(
          opened.some((s) => tabKey(s) === saved.active)
            ? saved.active
            : opened[0]
              ? tabKey(opened[0])
              : '',
        );
      } catch {
        setTabs([]);
        setActive('');
      }
    }
    setUser(u);
  }
  // 저장 후 최신 권한을 열린 탭에 반영하고 접근 목록에서 빠진 화면은 제거한다.
  async function refreshNavigation() {
    try {
      const n: Nav = await api('navigation');
      setNav(n);
      setTabs((old) =>
        old.flatMap((t) => {
          const s = n.screens.find((s) => tabKey(s) === tabKey(t));
          return s ? [{ ...s, path: pathFor(n, s.menu_id) }] : [];
        }),
      );
    } catch (e) {
      notify('메뉴 갱신이 필요합니다. ' + (e as Error).message, 'error');
    }
  }
  useEffect(() => {
    api('me')
      .then((r) => initialize(r.user))
      .catch(() => api('auth/csrf'))
      .catch(() => notify('서버에 연결할 수 없습니다.', 'error'))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    if (!tabs.some((t) => tabKey(t) === active)) setActive(tabs.length ? tabKey(tabs.at(-1)!) : '');
    if (user)
      sessionStorage.setItem('tabs:' + user.id, JSON.stringify({ keys: tabs.map(tabKey), active }));
  }, [tabs, active, user]);
  useEffect(() => {
    if (!user) return;
    let last = 0;
    const activity = () => {
      if (Date.now() - last > 60000) {
        last = Date.now();
        api('auth/activity', { method: 'POST', body: '{}' }).catch((e) =>
          notify(e.message, 'error'),
        );
      }
    };
    window.addEventListener('keydown', activity);
    window.addEventListener('pointerdown', activity);
    return () => {
      window.removeEventListener('keydown', activity);
      window.removeEventListener('pointerdown', activity);
    };
  }, [user]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    clear();
    const form = new FormData(e.currentTarget);
    try {
      if (user?.mustChangePassword) {
        const r = await api('auth/password', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(form)),
        });
        setUser(null);
        notify(r.message);
        await api('auth/csrf');
      } else {
        await api('auth/csrf');
        const r = await api('auth/login', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(form)),
        });
        await initialize(r.user);
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api('auth/logout', { method: 'POST', body: '{}' });
      if (user) sessionStorage.removeItem('tabs:' + user.id);
      setUser(null);
      setTabs([]);
      setActive('');
      setStates({});
      handles.current.clear();
      clear();
      await api('auth/csrf');
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }
  function open(s: Screen, path: string[]) {
    setTabs((old) =>
      old.some((t) => tabKey(t) === tabKey(s))
        ? old.map((t) => (tabKey(t) === tabKey(s) ? { ...s, path } : t))
        : [...old, { ...s, path }],
    );
    setActive(tabKey(s));
    clear();
  }
  function discard(keys: string[]) {
    setTabs((old) => old.filter((t) => !keys.includes(tabKey(t))));
    setStates((old) => Object.fromEntries(Object.entries(old).filter(([k]) => !keys.includes(k))));
    keys.forEach((k) => handles.current.delete(k));
  }
  // 처리 중에는 닫지 않는다. 현재 구현은 미저장 확인 없이 해당 탭 상태를 폐기한다.
  function requestClose(keys: string[]) {
    setContext(null);
    if (running || keys.some((k) => states[k]?.busy)) {
      notify('작업이 완료된 후 닫아주세요.');
      return;
    }
    discard(keys);
  }
  // 허용된 버튼만 실행한다. 화면별 동작 재정의가 공통 동작보다 우선한다.
  async function action(code: string) {
    const h = handles.current.get(active);
    if (
      !current?.buttons[code]?.allowed ||
      !h ||
      states[active]?.disabledActions?.includes(code) ||
      (states[active]?.visibleActions && !states[active].visibleActions!.includes(code))
    )
      return;
    const method =
      h.actions?.[code] ||
      (code === 'RESET'
        ? h.reset
        : code === 'QUERY'
          ? h.query
          : code === 'SAVE'
            ? h.save
            : code === 'DELETE'
              ? h.remove
              : undefined);
    if (!method) {
      notify('아직 연결되지 않은 기능입니다.');
      return;
    }
    setRunning(true);
    try {
      await method();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  }
  if (recoveryLink || (!user && recovering))
    return (
      <>
        {toasts}
        <RecoveryScreen
          code={customerCode}
          link={recoveryLink}
          notify={notify}
          onBack={() => {
            setRecoveryLink(null);
            setRecovering(false);
            setUser(null);
            void api('auth/csrf');
          }}
        />
      </>
    );
  if (!user && signup)
    return (
      <>
        {toasts}
        <SignupScreen code={customerCode} onBack={() => setSignup(false)} notify={notify} />
      </>
    );
  if (!user || user.mustChangePassword)
    return (
      <>
        {toasts}
        <main className="login">
          <form onSubmit={submit}>
            <small>CPJT · WORKSPACE</small>
            <h1>{user ? '비밀번호 변경' : '로그인'}</h1>
            <p>
              {user
                ? '처음 로그인했습니다. 사용할 비밀번호를 설정해주세요.'
                : '업무 계정으로 시작하세요.'}
            </p>
            {user ? (
              <>
                <label>
                  현재 비밀번호
                  <input
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                  />
                </label>
                <label>
                  새 비밀번호
                  <input
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={15}
                    maxLength={128}
                    required
                  />
                </label>
                <small>15자 이상 입력해주세요.</small>
              </>
            ) : (
              <>
                <label>
                  아이디
                  <input name="loginId" autoComplete="username" required maxLength={80} />
                </label>
                <label>
                  비밀번호
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                  />
                </label>
              </>
            )}
            <button disabled={busy}>{busy ? '처리 중…' : user ? '변경' : '로그인'}</button>
            {!user && (
              <button type="button" disabled={busy} onClick={() => setRecovering(true)}>
                아이디 찾기 / 비밀번호 재설정
              </button>
            )}
            {!user && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  customerCode
                    ? setSignup(true)
                    : notify('고객사에서 안내받은 가입 링크로 접속해주세요.')
                }
              >
                회원가입
              </button>
            )}
          </form>
        </main>
      </>
    );
  return (
    <div
      className={'workspace' + (sidebar.dragging ? ' sidebar-dragging' : '')}
      style={{ gridTemplateColumns: sidebar.width + 'px minmax(0,1fr)' }}
      onClick={() => context && setContext(null)}
    >
      {toasts}
      <header>
        <strong>CPJT</strong>
        <span>{user.displayName}</span>
        <button onClick={refreshNavigation}>메뉴 새로고침</button>
        <button onClick={logout}>로그아웃</button>
      </header>
      <div className={'sidebar-pane' + (sidebar.collapsed ? ' collapsed' : '')}>
        <aside id="sidebar-menu" hidden={sidebar.collapsed}>
          <small>메뉴</small>
          {nav.rootMenuId && (
            <Branch
              n={nav}
              id={nav.rootMenuId}
              path={[nav.rootMenuId]}
              active={active}
              open={open}
            />
          )}
        </aside>
        {sidebar.handle}
      </div>
      <main className="work">
        <div className="toolbar">
          <strong>
            {current
              ? [
                  ...current.path.map((id) => nav.menus.find((m) => m.id === id)?.name || ''),
                  current.name,
                ].join(' > ')
              : '화면 선택'}
          </strong>
          <div className="toolbar-actions">
            {actions
              .filter(
                (a) =>
                  current?.buttons[a]?.allowed &&
                  (!states[active]?.visibleActions || states[active].visibleActions!.includes(a)),
              )
              .map((a) => (
                <button
                  key={a}
                  disabled={
                    running || states[active]?.busy || states[active]?.disabledActions?.includes(a)
                  }
                  onClick={() => action(a)}
                >
                  {handles.current.get(active)?.buttonLabels?.[a] ||
                    buttonLabel(current!.component_key, a)}
                </button>
              ))}
          </div>
        </div>
        <div className="content">
          {!current && <div className="empty">왼쪽 메뉴에서 화면을 선택해주세요.</div>}
          {tabs.map((t) => (
            <div key={tabKey(t)} hidden={tabKey(t) !== active}>
              {Object.hasOwn(sourceModules, t.component_key || '') ? (
                <RegistrationScreen
                  kind={sourceModules[t.component_key!].kind}
                  screen={t}
                  ref={(h) => {
                    if (h) handles.current.set(tabKey(t), h);
                    else handles.current.delete(tabKey(t));
                  }}
                  notify={notify}
                  onState={(s) => markState(tabKey(t), s)}
                  onSaved={refreshNavigation}
                />
              ) : t.component_key === 'user-register' ? (
                <AccountsScreen
                  screen={t}
                  notify={notify}
                  onState={(s) => markState(tabKey(t), s)}
                  ref={(h) => {
                    if (h) handles.current.set(tabKey(t), h);
                    else handles.current.delete(tabKey(t));
                  }}
                />
              ) : ['customer-register', 'corporation-register', 'department-register'].includes(
                  t.component_key || '',
                ) ? (
                <CustomersScreen
                  screen={t}
                  notify={notify}
                  onState={(s) => markState(tabKey(t), s)}
                  ref={(h) => {
                    if (h) handles.current.set(tabKey(t), h);
                    else handles.current.delete(tabKey(t));
                  }}
                />
              ) : t.component_key === 'audit' ? (
                <AuditScreen
                  screen={t}
                  ref={(h) => {
                    if (h) handles.current.set(tabKey(t), h);
                    else handles.current.delete(tabKey(t));
                  }}
                  notify={notify}
                />
              ) : (
                <div className="empty">연결된 화면이 아직 준비되지 않았습니다.</div>
              )}
            </div>
          ))}
        </div>
        <footer
          onContextMenu={(e) => {
            e.preventDefault();
            const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tab-key]');
            setContext({
              x: Math.max(4, Math.min(e.clientX, window.innerWidth - 164)),
              y: Math.max(4, Math.min(e.clientY, window.innerHeight - 92)),
              key: target?.dataset.tabKey || active,
            });
          }}
        >
          {tabs.map((t) => (
            <div
              data-tab-key={tabKey(t)}
              className={active === tabKey(t) ? 'tab active' : 'tab'}
              key={tabKey(t)}
            >
              <button onClick={() => setActive(tabKey(t))}>
                {t.name}
                {states[tabKey(t)]?.dirty ? ' *' : ''}
              </button>
              <button aria-label={t.name + ' 닫기'} onClick={() => requestClose([tabKey(t)])}>
                ×
              </button>
            </div>
          ))}
          {context && (
            <div
              className="context"
              role="menu"
              aria-label="탭 작업"
              style={{ left: context.x, top: context.y }}
            >
              <button
                role="menuitem"
                disabled={!context.key}
                onClick={() => requestClose([context.key])}
              >
                탭 닫기
              </button>
              <button
                role="menuitem"
                disabled={!tabs.length}
                onClick={() => requestClose(tabs.map(tabKey))}
              >
                전체 닫기
              </button>
            </div>
          )}
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
