/**
 * React 진입점과 업무 창틀. 로그인·메뉴 트리·탭·공통 툴바를 관리한다.
 * 탭은 메뉴와 화면 ID 조합으로 식별하여 메뉴별 권한을 구분한다.
 */
import React, { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { SignupScreen } from './SignupScreen';
import { WorkspaceSignupScreen } from './WorkspaceSignupScreen';
import { SrPortalScreen } from './SrPortalScreen';
import { NotificationBell } from './NotificationBell';
import { FeedbackButton } from './FeedbackButton';
import { StartGuide } from './StartGuide';
import { Icon } from './Icon';
import { RecoveryScreen, RecoveryLink } from './RecoveryScreen';
import { sourceModules, buttonLabel } from './sourceModules';
import { actions, Nav, Screen, ScreenHandle, Tab, tabKey, User, ViewState } from './types';
import './style.css';
import { useToasts } from './Toasts';
import { useSidebar } from './useSidebar';
import { checkForm, clearInvalid } from './formCheck';
import { ConfirmHost, useConfirmOpen } from './ConfirmDialog';
/*
 * 업무 화면 나눠 받기(QA DL-029: 화면 파일 하나가 1.4MB). lazy: 그 화면을 처음 열 때 해당 파일만 내려받는다.
 * 표 편집기(AG Grid)를 쓰는 등록·관리 화면이 크므로 나누고, 로그인·고객 요청 화면은 첫 파일에 남겨 바로 뜨게 한다.
 * import(...).then(m => ({ default: m.이름 })): lazy는 기본 내보내기(default)를 기대하므로 이름 있는 내보내기를 감싼다.
 */
// 화면 파일 내려받기 함수 모음. 같은 함수를 lazy와 '미리 받기'(아래 prefetchScreens)가 함께 쓴다.
// 브라우저는 한 번 받은 파일을 기억하므로, 미리 받아 두면 화면을 열 때 기다림 없이 뜬다.
const loaders = {
  audit: () => import('./AuditScreen'),
  registration: () => import('./RegistrationScreen'),
  accounts: () => import('./AccountsScreen'),
  customers: () => import('./CustomersScreen'),
  desk: () => import('./SrDeskScreen'),
  sla: () => import('./SlaSettingsScreen'),
  report: () => import('./SrReportScreen'),
  feedback: () => import('./FeedbackInboxScreen'),
};
const AuditScreen = lazy(() => loaders.audit().then((m) => ({ default: m.AuditScreen })));
const RegistrationScreen = lazy(() =>
  loaders.registration().then((m) => ({ default: m.RegistrationScreen })),
);
const AccountsScreen = lazy(() => loaders.accounts().then((m) => ({ default: m.AccountsScreen })));
const CustomersScreen = lazy(() =>
  loaders.customers().then((m) => ({ default: m.CustomersScreen })),
);
const SrDeskScreen = lazy(() => loaders.desk().then((m) => ({ default: m.SrDeskScreen })));
const SlaSettingsScreen = lazy(() => loaders.sla().then((m) => ({ default: m.SlaSettingsScreen })));
const SrReportScreen = lazy(() => loaders.report().then((m) => ({ default: m.SrReportScreen })));
const FeedbackInboxScreen = lazy(() =>
  loaders.feedback().then((m) => ({ default: m.FeedbackInboxScreen })),
);
/**
 * 로그인 뒤 잠시 쉬었다가 업무 화면 파일을 미리 받는다(QA 3차 DL-029: 고객사등록 첫 진입에 '화면을 불러오는 중…' 약 15초).
 * 고객 요청 화면만 쓰는 고객 사용자는 큰 표 부품(약 1MB)을 받을 필요가 없어 건너뛴다.
 * 실패해도(네트워크 끊김 등) 화면을 열 때 다시 받으므로 오류를 무시한다.
 */
function prefetchScreens() {
  for (const load of Object.values(loaders)) void load().catch(() => undefined);
}
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
// 업무 화면 구현 키 → 컴포넌트. 모두 screen·notify·onState·ref 계약을 따른다.
const workScreens: Record<string, React.ComponentType<any>> = {
  'sr-portal': SrPortalScreen,
  'sr-desk': SrDeskScreen,
  'sla-settings': SlaSettingsScreen,
  'sr-report': SrReportScreen,
  'feedback-inbox': FeedbackInboxScreen,
};
/**
 * 탭 사이 로그인 상태 알림. BroadcastChannel: 같은 브라우저·같은 사이트의 다른 탭에 짧은 메시지를 보내는 통로.
 * 로그인하면 사용자 ID, 로그아웃하면 빈 문자열을 보낸다. 받는 탭은 자기 사용자와 다르면 새로고침한다.
 * BroadcastChannel이 없는 오래된 브라우저에서는 아무 일도 하지 않는다(그 경우 서버 권한 검사가 여전히 막는다).
 */
const authChannel =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('doneline-auth');
function announceAuth(userId: string) {
  authChannel?.postMessage(userId);
}
function onAuthChange(handler: (userId: string) => void) {
  if (!authChannel) return () => {};
  const listener = (e: MessageEvent) => handler(String(e.data || ''));
  authChannel.addEventListener('message', listener);
  return () => authChannel.removeEventListener('message', listener);
}
function App() {
  // 고객사 회원가입 링크의 가입 토큰. 고객사등록 화면이 만든 /?signup=<토큰> 주소에서 읽는다.
  // useState(() => ...): 처음 한 번만 읽어 기억한다. 로그인하면 주소창의 토큰을 지우는데(DLV2-021),
  // 매번 주소창에서 다시 읽으면 로그아웃 뒤 초대 화면에서 [회원가입] 버튼이 사라졌다(QA DLV3-003).
  const [signupToken] = useState(
    () => new URLSearchParams(window.location.search).get('signup') || '',
  );
  const [signup, setSignup] = useState(false);
  // 업체(워크스페이스) 무료 가입 화면 표시 여부. 링크 없이 로그인 화면에서 바로 연다.
  // 소개 페이지(landing)의 [무료로 시작하기]는 /?start=1로 들어와 이 화면을 바로 연다(로그인 화면을 한 번 더 거치지 않게).
  const [workspaceSignup, setWorkspaceSignup] = useState(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('start') !== '1') return false;
    url.searchParams.delete('start');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return true;
  });
  // 가입 링크의 고객사·업체 이름(로그인 화면 안내용). 토큰이 잘못되었으면 null로 두고 회원가입 화면에서 오류를 보여 준다.
  // 가입 링크 확인이 끝났는지. 끝났는데 정보가 없으면 잘못된 링크로 보고 안내한다(확인 중에는 안내하지 않음).
  const [signupChecked, setSignupChecked] = useState(false);
  const [signupInfo, setSignupInfo] = useState<{
    customerName: string;
    workspaceName: string;
  } | null>(null);
  useEffect(() => {
    if (!signupToken) return;
    api('signup/' + encodeURIComponent(signupToken))
      .then((r) => setSignupInfo(r))
      .catch(() => setSignupInfo(null))
      .finally(() => setSignupChecked(true));
  }, [signupToken]);
  // 휴대폰 화면에서 사이드 메뉴 펼침 여부.
  const [menuOpen, setMenuOpen] = useState(false);
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
  // 확인 창에서 답을 기다리는 중이면 아직 처리가 시작된 것이 아니므로 '처리 중' 표시를 숨긴다(QA DLV3-002).
  // 버튼은 그동안에도 막아 둔다(같은 동작이 두 번 시작되지 않게).
  const asking = useConfirmOpen();
  const handles = useRef(new Map<string, ScreenHandle>());
  /*
   * 탭 화면의 툴바 동작(handle)을 등록하는 ref 함수. 탭마다 같은 함수를 재사용한다.
   * 여기서 화면을 다시 그리게(setState) 하면 안 된다: 화면이 다시 그려질 때마다 handle이 새로 등록되어 무한 반복된다.
   * 화면을 나눠 받기(lazy) 때문에 파일 도착 전에는 handle이 없다. 각 화면은 처음 붙을 때 onState로 상태를 알리고
   * 그 알림이 창틀을 다시 그리므로, 그때 툴바 버튼이 풀린다(파일 도착 전 클릭이 무시되던 문제 방지).
   */
  const refCache = useRef(new Map<string, (h: ScreenHandle | null) => void>());
  function refFor(key: string) {
    let bind = refCache.current.get(key);
    if (!bind) {
      bind = (h) => {
        if (h) handles.current.set(key, h);
        else handles.current.delete(key);
      };
      refCache.current.set(key, bind);
    }
    return bind;
  }
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
    // 가입 링크로 들어와 로그인했으면 주소창의 ?signup=<토큰>을 지운다. 남겨 두면 화면을 옮겨도 계속 보여
    // 화면 공유·캡처·방문 기록으로 가입 링크가 새어 나갈 수 있다(QA DLV2-021).
    const url = new URL(window.location.href);
    if (url.searchParams.has('signup')) {
      url.searchParams.delete('signup');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
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
        // 열 수 있는 화면이 하나뿐이면(예: 고객사 사용자의 '고객 요청') 빈 화면 대신 바로 연다.
        // 고객사 사용자·관리자는 주 업무인 '고객 요청'을 바로 연다(관리자는 다른 메뉴도 있지만 요청 확인이 우선).
        const visible = n.screens.filter((s) => !s.hidden);
        const first =
          visible.length === 1
            ? visible[0]
            : !u.staff
              ? visible.find((s) => s.code === 'SR_PORTAL')
              : undefined;
        if (!opened.length && first) opened.push({ ...first, path: pathFor(n, first.menu_id) });
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
    // 로그인 경로(로그인 폼·링크·업체 가입·새로고침)와 관계없이 다른 탭에 현재 사용자를 알린다.
    announceAuth(u.id);
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
  // 다른 브라우저 탭에서 로그인·로그아웃하면 이 탭도 새로 읽는다. 로그인 정보(쿠키)는 같은 브라우저의 모든 탭이
  // 함께 쓰므로, 그대로 두면 이 탭이 이전 사용자의 화면을 계속 보여 주고 1분 자동 새로고침이 새 사용자 권한으로
  // 거절되어 감사 로그에 '권한 없음' 실패가 쌓인다(QA DLV2-008·018). userRef: 이벤트 함수 안에서 최신 사용자를 읽는다.
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  useEffect(
    () =>
      onAuthChange((id) => {
        if ((userRef.current?.id || '') !== id) window.location.reload();
      }),
    [],
  );
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
  // 업무 화면이 하나라도 메뉴에 있으면 2초 뒤 화면 파일을 미리 받는다(첫 화면 표시를 방해하지 않게 조금 늦춘다).
  useEffect(() => {
    if (!user || !nav.screens.some((x) => x.component_key && x.component_key !== 'sr-portal'))
      return;
    const timer = setTimeout(prefetchScreens, 2000);
    return () => clearTimeout(timer);
  }, [user, nav]);
  // 로그인 폼의 오류 문장. 우하단 알림은 금방 사라지고 폼과 멀어 놓치기 쉬워 폼 안에 남긴다(QA DL-024).
  const [loginError, setLoginError] = useState('');
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const bad = checkForm(formEl);
    setLoginError(bad);
    if (bad) return;
    setBusy(true);
    clear();
    const form = new FormData(formEl);
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
      setLoginError((e as Error).message);
      // 실패하면 비밀번호 칸을 비우고 다시 입력하게 한다(공용 PC에서 남지 않게).
      const pw = formEl.elements.namedItem(user ? 'currentPassword' : 'password');
      if (pw instanceof HTMLInputElement) {
        pw.value = '';
        pw.setAttribute('aria-invalid', 'true');
        pw.focus();
      }
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api('auth/logout', { method: 'POST', body: '{}' });
      announceAuth('');
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
    setMenuOpen(false);
    clear();
  }
  // 알림에서 요청을 열 때 대상 요청 ID. seq를 매번 올려 같은 요청을 다시 눌러도 화면이 반응하게 한다.
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | null>(null);
  /** 알림 클릭: 요청 알림은 요청 화면(고객 요청 또는 작업함)을 열고 그 요청을 선택, 가입 알림은 사용자등록을 연다. */
  function openNotification(n: { request_id?: string | null; message: string }) {
    const code = n.request_id
      ? nav.screens.some((s) => s.code === 'SR_DESK')
        ? 'SR_DESK'
        : 'SR_PORTAL'
      : n.message.startsWith('새 가입 신청')
        ? 'USER_REGISTER'
        : '';
    const s = nav.screens.find((x) => x.code === code);
    if (!s) return;
    open(s, pathFor(nav, s.menu_id));
    if (n.request_id) setFocusRequest({ id: String(n.request_id), seq: Date.now() });
  }
  // 업무 메일의 바로가기(/?request=<요청 ID>)로 들어온 경우 열 요청. 로그인 전이면 로그인 후 메뉴가 준비될 때 연다.
  // useRef: 값이 바뀌어도 화면을 다시 그리지 않는 보관함. 한 번 연 뒤 비워서 다시 열리지 않게 한다.
  const linkedRequest = useRef(
    /^\d{1,18}$/.exec(new URLSearchParams(window.location.search).get('request') || '')?.[0] || '',
  );
  useEffect(() => {
    if (!linkedRequest.current || !nav.screens.length) return;
    const id = linkedRequest.current;
    linkedRequest.current = '';
    // 주소창에서 요청 번호를 지워 새로고침 때 같은 요청이 다시 열리지 않게 한다.
    const url = new URL(window.location.href);
    url.searchParams.delete('request');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    openNotification({ request_id: id, message: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav]);
  function discard(keys: string[]) {
    setTabs((old) => old.filter((t) => !keys.includes(tabKey(t))));
    setStates((old) => Object.fromEntries(Object.entries(old).filter(([k]) => !keys.includes(k))));
    keys.forEach((k) => handles.current.delete(k));
  }
  // 처리 중에는 닫지 않는다. 현재 구현은 미저장 확인 없이 해당 탭 상태를 폐기한다.
  function requestClose(keys: string[]) {
    setContext(null);
    if (running || keys.some((k) => states[k]?.busy)) {
      notify('작업이 완료된 후 닫아 주세요.');
      return;
    }
    discard(keys);
  }
  // 허용된 버튼만 실행한다. 화면별 동작 재정의가 공통 동작보다 우선한다.
  async function action(code: string) {
    const h = handles.current.get(active);
    if (!current?.buttons[code]?.allowed || !h) return;
    // 조건이 맞지 않아 쓸 수 없는 버튼은 아무 반응 없이 무시하지 않고 이유를 알려 준다.
    if (
      states[active]?.disabledActions?.includes(code) ||
      (states[active]?.visibleActions && !states[active].visibleActions!.includes(code))
    ) {
      notify(
        '지금은 사용할 수 없습니다. 처리할 행을 체크했는지, 선택한 항목의 상태를 확인해 주세요.',
      );
      return;
    }
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
          code={signupToken}
          link={recoveryLink}
          notify={notify}
          onLoggedIn={(u) => {
            setRecoveryLink(null);
            setRecovering(false);
            void initialize(u);
          }}
          onBack={() => {
            setRecoveryLink(null);
            setRecovering(false);
            setUser(null);
            void api('auth/csrf');
          }}
        />
      </>
    );
  if (!user && workspaceSignup)
    return (
      <>
        {toasts}
        <WorkspaceSignupScreen
          onBack={() => setWorkspaceSignup(false)}
          onLoggedIn={(u) => {
            setWorkspaceSignup(false);
            void initialize(u);
          }}
          notify={notify}
        />
      </>
    );
  if (!user && signup)
    return (
      <>
        {toasts}
        <SignupScreen code={signupToken} onBack={() => setSignup(false)} notify={notify} />
      </>
    );
  if (!user || user.mustChangePassword)
    return (
      <>
        {toasts}
        <main className="login">
          {/* 왼쪽 소개 패널: 처음 온 사람이 무엇을 하는 서비스인지 알 수 있게 한다. 휴대폰에서는 위쪽 띠로 줄어든다. */}
          <section className="login-brand">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true" />
              Doneline
            </div>
            {signupToken ? (
              <>
                <p className="login-headline">
                  요청은 올리고, <br />
                  처리 상황은 바로 확인하세요.
                </p>
                <p>
                  {signupInfo
                    ? `${signupInfo.workspaceName}에서 운영하는 ${signupInfo.customerName} 전용 요청 창구`
                    : '담당 업체가 운영하는 고객 요청 창구'}
                </p>
              </>
            ) : (
              <>
                <p className="login-headline">
                  고객 요청을 <br />
                  접수부터 완료 확인까지 <br />
                  <em>한 줄로.</em>
                </p>
                <p>유지보수·IT 서비스 업체를 위한 고객 요청 포털</p>
              </>
            )}
            {/* 장식용 미리보기 카드(실제 데이터 아님). 고객이 자기 요청으로 오해하지 않게 '예시'라고 적는다(QA DLV2-012). */}
            <p className="login-preview-label" aria-hidden="true">
              화면 예시
            </p>
            <ul className="login-preview" aria-hidden="true">
              <li>
                <span className="sr-badge sr-OPEN">접수</span>회의실 프로젝터 화면이 안 나옵니다
              </li>
              <li>
                <span className="sr-badge sr-IN_PROGRESS">처리 중</span>신규 입사자 메일 계정 생성
              </li>
              <li>
                <span className="sr-badge sr-CLOSED">완료</span>그룹웨어 결재선 변경 문의
              </li>
            </ul>
          </section>
          {/* 다시 입력하기 시작하면 폼 안 오류 문장을 지운다(QA DLV2-016). clearInvalid는 칸의 빨간 표시(aria-invalid)를 푼다. */}
          <form
            onSubmit={submit}
            noValidate
            onInput={(e) => {
              clearInvalid(e);
              if (loginError) setLoginError('');
            }}
          >
            {/* 고객사 가입 링크로 들어온 경우: 어느 업체·고객사의 포털인지 먼저 보여 주고 회원가입으로 안내한다. */}
            {!user && signupToken && signupChecked && !signupInfo && (
              <div className="signup-banner warn" role="alert">
                <strong>가입 링크를 확인할 수 없습니다</strong>
                <span>
                  링크가 바뀌었거나 사용이 중지되었습니다. 링크를 보내 준 업체 담당자에게 새 가입
                  링크를 요청해 주세요. 이미 계정이 있으면 아래에서 로그인하면 됩니다.
                </span>
              </div>
            )}
            {!user && signupInfo && (
              <div className="signup-banner">
                <strong>{signupInfo.customerName}</strong> 고객 요청 포털
                <span>{signupInfo.workspaceName}에서 운영합니다.</span>
              </div>
            )}
            <h1>{user ? '비밀번호 변경' : '로그인'}</h1>
            <p>
              {user
                ? '처음 로그인했습니다. 사용할 비밀번호를 설정해 주세요.'
                : signupInfo
                  ? '처음이면 아래 [회원가입]으로 신청하세요. 승인 후 로그인할 수 있습니다.'
                  : '고객 요청 접수부터 처리·월간 리포트까지 한 화면에서 관리합니다.'}
            </p>
            {/* key: 변경 화면과 로그인 화면의 입력칸을 서로 다른 요소로 만든다. key가 없으면 React가 같은 자리의
                입력칸을 재사용해, 변경 후 로그인 화면의 '아이디' 칸(글자가 보이는 칸)에 방금 입력한 비밀번호가 남는다. */}
            {user ? (
              <Fragment key="change-password">
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
                    minLength={8}
                    maxLength={128}
                    required
                  />
                </label>
                <small>8자 이상 입력해 주세요.</small>
              </Fragment>
            ) : (
              <Fragment key="login">
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
              </Fragment>
            )}
            {loginError && (
              <p className="form-error" role="alert">
                {loginError}
              </p>
            )}
            {/* 고객사 가입 링크로 처음 온 사람의 주 행동은 회원가입이라 로그인 버튼을 보조 모양으로 낮춘다. */}
            <button className={signupToken && !user ? 'secondary' : 'primary'} disabled={busy}>
              {busy ? '처리 중…' : user ? '변경' : '로그인'}
            </button>
            {!user && (
              <button
                type="button"
                className="link-button login-link"
                disabled={busy}
                onClick={() => setRecovering(true)}
              >
                아이디 찾기 · 비밀번호 재설정
              </button>
            )}
            {/* 회원가입은 고객사 가입 링크로 들어온 사람에게만, 업체 가입은 링크 없이 들어온 사람에게만 보여
                고객이 실수로 업체를 만들거나 링크 없이 회원가입에서 막히지 않게 한다. */}
            {/* 링크가 확인되지 않으면(잘못된 링크) 가입해도 실패하므로 회원가입 버튼을 숨긴다(QA DL-013). */}
            {!user && signupToken && (signupInfo || !signupChecked) && (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => setSignup(true)}
              >
                회원가입
              </button>
            )}
            {!user && !signupToken && (
              <div className="login-cta">
                <span>유지보수·IT 서비스 업체이신가요?</span>
                <button type="button" disabled={busy} onClick={() => setWorkspaceSignup(true)}>
                  무료로 시작하기
                </button>
              </div>
            )}
            <a className="login-manual" href="/manual/" target="_blank" rel="noopener">
              처음이신가요? 사용 설명서 보기
            </a>
          </form>
        </main>
      </>
    );
  return (
    <div
      className={
        'workspace' + (sidebar.dragging ? ' sidebar-dragging' : '') + (menuOpen ? ' menu-open' : '')
      }
      style={{ gridTemplateColumns: sidebar.width + 'px minmax(0,1fr)' }}
      onClick={() => {
        if (context) setContext(null);
        // 휴대폰에서 메뉴 덮개 바깥(본문)을 누르면 메뉴를 닫는다.
        if (menuOpen) setMenuOpen(false);
      }}
    >
      {toasts}
      <header>
        {/* 저장·조회 등 처리 중에는 화면 맨 위에 움직이는 줄을 보여 '멈춘 것'으로 오해하지 않게 한다(QA DL-006). */}
        {(running || states[active]?.busy) && !asking && (
          <div className="progress-line" role="progressbar" aria-label="처리 중" />
        )}
        {/* 휴대폰에서는 사이드 메뉴를 숨기고 이 버튼으로 연다(style.css의 좁은 화면 규칙). */}
        <button
          className="menu-toggle"
          aria-label="메뉴 열기"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
        >
          <Icon name="menu" />
        </button>
        <strong className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Doneline
        </strong>
        {user.workspaceName && <em className="workspace-name">{user.workspaceName}</em>}
        {/* 오른쪽 영역: 전역 기능(알림·개선 요청)과 내 계정(이름·로그아웃)만 둔다.
            메뉴 새로고침은 화면·메뉴 등록 저장 시 자동으로 실행되므로 헤더에서 뺐다. */}
        <div className="header-actions">
          <NotificationBell onOpen={openNotification} />
          {/* 사용 설명서(frontend/public/manual)는 작업 중인 화면을 잃지 않도록 새 탭으로 연다. */}
          <a
            className="header-link"
            href="/manual/"
            target="_blank"
            rel="noopener"
            title="사용 설명서"
            aria-label="사용 설명서"
          >
            <Icon name="help" size={16} />
            <span>도움말</span>
          </a>
          <FeedbackButton page={current?.name} notify={notify} />
          <span className="user-chip" title={user.displayName}>
            {user.displayName}
          </span>
          <button className="icon-button" aria-label="로그아웃" title="로그아웃" onClick={logout}>
            <Icon name="logout" />
          </button>
        </div>
      </header>
      <div
        className={'sidebar-pane' + (sidebar.collapsed ? ' collapsed' : '')}
        // 메뉴 안을 누른 것은 바깥 클릭으로 보지 않아 폴더를 펼쳐도 메뉴가 닫히지 않게 한다.
        onClick={(e) => e.stopPropagation()}
      >
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
          {/* 위치 표시: 메뉴 경로는 작은 글씨로, 지금 보는 화면 이름은 크게 보여 위치를 바로 알게 한다. */}
          <div className="toolbar-title">
            {current && current.path.length > 0 && (
              <small>
                {current.path
                  .map((id) => nav.menus.find((m) => m.id === id)?.name || '')
                  .join(' / ')}
              </small>
            )}
            {/* 화면마다 제목을 h1로 둔다(화면 읽기 프로그램의 제목 이동, QA DL-026). */}
            <h1 className="screen-title">{current ? current.name : '시작하기'}</h1>
          </div>
          <div className="toolbar-actions">
            {/* 처리 중에는 버튼 옆에 글자로도 알린다. 맨 위 줄만으로는 눈에 잘 띄지 않았다(QA DL-006).
                role="status": 화면 낭독기가 '처리 중'을 읽어 준다. */}
            {(running || states[active]?.busy) && !asking && (
              <span className="busy-note" role="status">
                처리 중…
              </span>
            )}
            {actions
              .filter(
                (a) =>
                  current?.buttons[a]?.allowed &&
                  (!states[active]?.visibleActions || states[active].visibleActions!.includes(a)),
              )
              .map((a) => (
                <button
                  key={a}
                  // 버튼 위계: 저장은 주요 동작(채움), 삭제는 위험 동작(빨간 테두리), 나머지는 보조 동작.
                  data-kind={a === 'SAVE' ? 'primary' : a === 'DELETE' ? 'danger' : undefined}
                  // 처리 중일 때만 실제로 막는다. 조건이 안 맞는 버튼은 흐리게만 표시하고, 누르면 이유를 알려 준다.
                  disabled={running || states[active]?.busy || !handles.current.has(active)}
                  aria-disabled={states[active]?.disabledActions?.includes(a) || undefined}
                  className={
                    states[active]?.disabledActions?.includes(a) ? 'is-disabled' : undefined
                  }
                  onClick={() => action(a)}
                >
                  {handles.current.get(active)?.buttonLabels?.[a] ||
                    buttonLabel(current!.component_key, a)}
                </button>
              ))}
          </div>
        </div>
        {/* aria-busy: 이 영역이 처리 중이라 내용이 곧 바뀐다는 뜻. 보조 기술이 중간 상태를 읽지 않게 한다. */}
        <div className="content" aria-busy={running || states[active]?.busy || undefined}>
          {!current && (
            <StartGuide
              user={user}
              canOpen={(code) => nav.screens.some((s) => s.code === code)}
              onOpen={(code) => {
                const s = nav.screens.find((x) => x.code === code);
                if (s) open(s, pathFor(nav, s.menu_id));
              }}
            />
          )}
          {tabs.map((t) => (
            <div key={tabKey(t)} hidden={tabKey(t) !== active}>
              {/* Suspense: 나눠 받는 화면 파일을 내려받는 동안 대신 보여 줄 내용. */}
              <Suspense fallback={<p className="hint">화면을 불러오는 중…</p>}>
                {Object.hasOwn(sourceModules, t.component_key || '') ? (
                  <RegistrationScreen
                    kind={sourceModules[t.component_key!].kind}
                    screen={t}
                    ref={refFor(tabKey(t))}
                    notify={notify}
                    onState={(s) => markState(tabKey(t), s)}
                    onSaved={refreshNavigation}
                  />
                ) : t.component_key === 'user-register' ? (
                  <AccountsScreen
                    screen={t}
                    notify={notify}
                    onState={(s) => markState(tabKey(t), s)}
                    ref={refFor(tabKey(t))}
                  />
                ) : ['customer-register', 'corporation-register', 'department-register'].includes(
                    t.component_key || '',
                  ) ? (
                  <CustomersScreen
                    screen={t}
                    notify={notify}
                    onState={(s) => markState(tabKey(t), s)}
                    ref={refFor(tabKey(t))}
                  />
                ) : Object.hasOwn(workScreens, t.component_key || '') ? (
                  // 고객 요청·작업함·SLA·리포트는 같은 props 계약을 쓰므로 구현 키로 컴포넌트만 고른다.
                  (() => {
                    const Sr = workScreens[t.component_key!];
                    return (
                      <Sr
                        screen={t}
                        focus={focusRequest}
                        notify={notify}
                        onState={(s: ViewState) => markState(tabKey(t), s)}
                        ref={refFor(tabKey(t))}
                      />
                    );
                  })()
                ) : t.component_key === 'audit' ? (
                  <AuditScreen
                    screen={t}
                    ref={refFor(tabKey(t))}
                    notify={notify}
                    onState={(s) => markState(tabKey(t), s)}
                  />
                ) : (
                  <div className="empty">연결된 화면이 아직 준비되지 않았습니다.</div>
                )}
              </Suspense>
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
          {/* 하단 탭이 상태 표시줄로 오해되지 않게 이름표를 붙인다(QA DL-023). */}
          {tabs.length > 0 && (
            <span className="tab-caption" aria-hidden="true">
              열린 화면
            </span>
          )}
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
              <button
                className="tab-close"
                aria-label={t.name + ' 닫기'}
                onClick={() => requestClose([tabKey(t)])}
              >
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
// ConfirmHost: 어느 화면에서든 confirmAction()으로 띄우는 공통 확인 창(ConfirmDialog.tsx).
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <ConfirmHost />
  </>,
);
