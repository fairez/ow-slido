import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/** Files whose UI text has moved to the message files. Add a file here when it is migrated. */
const MIGRATED = [
  "components/password-forms.tsx",
  "components/plan-hint.tsx",
  "components/plan-overview.tsx",
  "components/plan-billing.tsx",
  "app/dashboard/plan/page.tsx",
  "components/members-manager.tsx",
  "components/audit-log.tsx",
  "components/ops-workspaces.tsx",
  "app/ops/page.tsx",
  "app/ops/activity/page.tsx",
  "app/ops/workspaces/[id]/page.tsx",
  "app/account/suspended/page.tsx",
  "components/event-unavailable.tsx",
  "components/ops-workspace-manager.tsx",
  "components/ops-ai-panel.tsx",
  "components/ops-activity.tsx",
  "app/dashboard/audit/page.tsx",
  "components/invite-accept-form.tsx",
  "app/dashboard/members/page.tsx",
  "app/invite/page.tsx",
  "app/change-password/page.tsx",
  "app/forgot/page.tsx",
  "app/reset/page.tsx",
  "app/account/password/page.tsx",
  "app/join/[code]/page.tsx",
  "app/e/[eventId]/page.tsx",
  "components/join-form.tsx",
  "components/join-redirect.tsx",
  "components/participant-view.tsx",
  "components/live-view.tsx",
  "components/qa-tab.tsx",
  "components/shared-notes-panel.tsx",
  "components/open-text-form.tsx",
  "components/rating-form.tsx",
  "components/ranking-form.tsx",
  "components/quiz-form.tsx",
  "components/nickname-form.tsx",
  "components/published-analysis.tsx",
  "components/word-cloud.tsx",
  "app/dashboard/events/[id]/page.tsx",
  "app/dashboard/page.tsx",
  "app/not-found.tsx",
  "app/dashboard/events/[id]/moderate/page.tsx",
  "app/page.tsx",
  "app/login/page.tsx",
  "app/signup/page.tsx",
  "app/present/[eventId]/page.tsx",
  "components/add-content-menu.tsx",
  "components/plan-error.tsx",
  "components/save-template-dialog.tsx",
  "components/template-items.tsx",
  "components/template-picker.tsx",
  "components/templates-manager.tsx",
  "app/dashboard/templates/page.tsx",
  "components/analysis-editor.tsx",
  "components/auth-form.tsx",
  "components/security-settings.tsx",
  "app/account/security/page.tsx",
  "components/event-manager.tsx",
  "components/live-participant-count.tsx",
  "components/logout-button.tsx",
  "components/moderation-panel.tsx",
  "components/notes-analysis-panel.tsx",
  "components/open-text-host-panel.tsx",
  "components/poll-manager.tsx",
  "components/survey-builder.tsx",
  "components/survey-form.tsx",
  "components/presenter-survey.tsx",
  "components/survey-link.tsx",
  "components/survey-preview.tsx",
  "components/presenter-analysis.tsx",
  "components/presenter-notes.tsx",
  "components/presenter-open-text.tsx",
  "components/presenter-qa.tsx",
  "components/presenter-ranking.tsx",
  "components/presenter-quiz.tsx",
  "components/presenter-podium.tsx",
  "components/leaderboard-list.tsx",
  "components/presenter-rating.tsx",
  "components/presenter-view.tsx",
  "components/rating-chart.tsx",
  "components/theme-toggle.tsx",
  "components/ui/app-shell.tsx",
  "components/workspace-switcher.tsx",
];

/** Props that carry text a person reads or hears. */
const TEXT_PROPS = new Set([
  "aria-label",
  "label",
  "title",
  "placeholder",
  "hint",
  "alt",
  "aria-description",
]);

const hasLetters = (s: string) => /\p{L}/u.test(s);

/** Returns "line: text" for every literal in JSX that should be a message key. */
export function findInlineStrings(file: string, source: string): string[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push(`${file}:${line + 1}: ${text.trim().slice(0, 40)}`);
  };
  const literalsIn = (
    node: ts.Node,
    visit: (lit: ts.Node, text: string) => void,
  ) => {
    const walk = (n: ts.Node) => {
      // Nested JSX is visited by the main walk; t("key") arguments are keys, not text.
      if (
        ts.isJsxElement(n) ||
        ts.isJsxSelfClosingElement(n) ||
        ts.isJsxFragment(n)
      )
        return;
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "t"
      )
        return;
      // Identifiers compared or listed as constants are not shown to anyone.
      if (ts.isAsExpression(n)) return;
      if (
        ts.isBinaryExpression(n) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(n.operatorToken.kind)
      )
        return;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
        visit(n, n.text);
      else if (
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n)
      )
        visit(n, n.text);
      ts.forEachChild(n, walk);
    };
    walk(node);
  };
  const walk = (node: ts.Node) => {
    if (ts.isJsxText(node) && hasLetters(node.text)) report(node, node.text);
    if (
      ts.isJsxExpression(node) &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      node.expression
    ) {
      literalsIn(
        node.expression,
        (lit, text) => hasLetters(text) && report(lit, text),
      );
    }
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      TEXT_PROPS.has(node.name.getText(sf))
    ) {
      if (ts.isStringLiteral(node.initializer)) {
        if (hasLetters(node.initializer.text))
          report(node.initializer, node.initializer.text);
      } else {
        literalsIn(
          node.initializer,
          (lit, text) => hasLetters(text) && report(lit, text),
        );
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

describe("no inline UI strings", () => {
  it("flags text literals, expression strings and text props", () => {
    const sample = `const a = <p aria-label="Hi">Hello {x}{"there"}{ok ? "yes" : t("k")}</p>; const b = <i>▲ {n}</i>;`;
    expect(findInlineStrings("s.tsx", sample)).toHaveLength(4);
  });

  it.each(MIGRATED)("%s has none", (file) => {
    expect(findInlineStrings(file, readFileSync(file, "utf8"))).toEqual([]);
  });
});
