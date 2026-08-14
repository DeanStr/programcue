import { ChevronDown } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

const MOBILE_ADMIN_QUERY = "(max-width: 760px)";

function subscribeToMobileViewport(onChange: () => void) {
  const media = window.matchMedia(MOBILE_ADMIN_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function mobileViewportSnapshot() {
  return window.matchMedia(MOBILE_ADMIN_QUERY).matches;
}

function serverViewportSnapshot() {
  return false;
}

export type AdminPageSectionLink = {
  id: string;
  label: string;
};

export function AdminPageSectionNavigation({
  label,
  links,
}: {
  label: string;
  links: AdminPageSectionLink[];
}) {
  return (
    <nav className="pc-admin-section-nav" aria-label={label}>
      <span>On this page</span>
      <ul>
        {links.map((link) => (
          <li key={link.id}>
            <a href={`#${link.id}`}>{link.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AdminPageSection({
  id,
  label,
  description,
  defaultExpandedOnMobile = false,
  children,
}: {
  id: string;
  label: string;
  description: string;
  defaultExpandedOnMobile?: boolean;
  children: ReactNode;
}) {
  const mobile = useSyncExternalStore(
    subscribeToMobileViewport,
    mobileViewportSnapshot,
    serverViewportSnapshot,
  );
  const [mobileExpanded, setMobileExpanded] = useState(defaultExpandedOnMobile);
  const sectionRef = useRef<HTMLElement>(null);
  const expanded = !mobile || mobileExpanded;
  const contentId = `${id}-content`;

  useEffect(() => {
    const revealTarget = (targetId: string) => {
      const target = document.getElementById(targetId);
      if (!target || !sectionRef.current?.contains(target)) return;
      setMobileExpanded(true);
      window.requestAnimationFrame(() =>
        target.scrollIntoView({ block: "start" }),
      );
    };
    const revealLinkedContent = (hash: string) => {
      if (!hash) return;
      let targetId: string;
      try {
        targetId = decodeURIComponent(hash.slice(1));
      } catch {
        return;
      }
      revealTarget(targetId);
    };
    const revealCurrentHash = () => revealLinkedContent(window.location.hash);
    const revealClickedLink = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href^="#"]');
      if (!link) return;
      revealLinkedContent(link.hash);
    };
    revealCurrentHash();
    window.addEventListener("hashchange", revealCurrentHash);
    document.addEventListener("click", revealClickedLink);
    return () => {
      window.removeEventListener("hashchange", revealCurrentHash);
      document.removeEventListener("click", revealClickedLink);
    };
  }, []);

  return (
    <section className="pc-admin-page-section" id={id} ref={sectionRef}>
      <button
        className="pc-admin-section-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setMobileExpanded((current) => !current)}
      >
        <span>
          <strong>{label}</strong>
          <small>{description}</small>
        </span>
        <ChevronDown aria-hidden size={18} />
      </button>
      <div id={contentId} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
