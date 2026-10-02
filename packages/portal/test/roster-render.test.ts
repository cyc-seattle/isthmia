import { describe, it, expect } from "vitest";
import {
  buildVCard,
  renderRoster,
  renderRosterBlocked,
  renderRosterGroups,
  ROSTER_HELP_TEXT,
  vCardDataUrl,
} from "../src/roster/render.js";
import type { ProgramGroup, TeamMember } from "../src/roster/model.js";

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    personId: "p1",
    fullName: "Ada Lovelace",
    school: "Lakeside",
    email: null,
    phone: null,
    programId: "prog-race",
    programName: "Race Team",
    teamName: "J-Pod",
    guardianContacts: [],
    ...overrides,
  };
}

describe("renderRosterGroups", () => {
  it("shows the help text when there are no groups", () => {
    const html = renderRosterGroups([]);
    expect(html).toContain(ROSTER_HELP_TEXT);
    expect(html).toContain("info@cyccommunitysailing.org");
  });

  it("renders each program as a collapsed section, opened only when it's the only one", () => {
    const groups: ProgramGroup[] = [{ programId: "prog-race", programName: "Race Team", members: [member()] }];
    const html = renderRosterGroups(groups);
    expect(html).toContain('<details class="roster-program" open>');
    expect(html).toContain("Race Team (1)");
    expect(html).toContain("Ada Lovelace");
  });

  it("leaves every program collapsed when there is more than one", () => {
    const groups: ProgramGroup[] = [
      { programId: "prog-race", programName: "Race Team", members: [member()] },
      { programId: "prog-learn", programName: "Learn to Sail", members: [member({ personId: "p2" })] },
    ];
    const html = renderRosterGroups(groups);
    expect(html).not.toContain("open>");
  });

  it("shows a member's school and contact only when present", () => {
    const withContact = renderRosterGroups([
      { programId: "p", programName: "Race Team", members: [member({ email: "ada@example.com", phone: "555-1234" })] },
    ]);
    expect(withContact).toContain("ada@example.com");
    expect(withContact).toContain("555-1234");

    const withoutContact = renderRosterGroups([
      { programId: "p", programName: "Race Team", members: [member({ school: null })] },
    ]);
    expect(withoutContact).not.toContain('class="roster-school"');
    expect(withoutContact).not.toContain('class="roster-contact"');
  });

  it("renders a member's email and phone as mailto: and tel: links, plus a vCard download", () => {
    const html = renderRosterGroups([
      {
        programId: "p",
        programName: "Race Team",
        members: [member({ email: "ada@example.com", phone: "555-1234" })],
      },
    ]);
    expect(html).toContain('<a href="mailto:ada@example.com">ada@example.com</a>');
    expect(html).toContain('<a href="tel:555-1234">555-1234</a>');
    expect(html).toContain('download="Ada Lovelace.vcf">Add to contacts</a>');
  });

  it("renders a shared guardian's email and phone as mailto: and tel: links too", () => {
    const html = renderRosterGroups([
      {
        programId: "p",
        programName: "Race Team",
        members: [
          member({
            guardianContacts: [
              { personId: "g1", fullName: "Gail Guardian", email: "gail@example.com", phone: "555-0100" },
            ],
          }),
        ],
      },
    ]);
    expect(html).toContain('<a href="mailto:gail@example.com">gail@example.com</a>');
    expect(html).toContain('<a href="tel:555-0100">555-0100</a>');
    expect(html).toContain('download="Gail Guardian.vcf">Add to contacts</a>');
  });

  it("shows an opted-in child's shared guardians under them", () => {
    const html = renderRosterGroups([
      {
        programId: "p",
        programName: "Race Team",
        members: [
          member({
            guardianContacts: [
              { personId: "g1", fullName: "Gail Guardian", email: "gail@example.com", phone: "555-0100" },
            ],
          }),
        ],
      },
    ]);
    expect(html).toContain("Gail Guardian");
    expect(html).toContain("gail@example.com");
    expect(html).toContain("555-0100");
  });

  it("escapes a member's name", () => {
    const html = renderRosterGroups([
      { programId: "p", programName: "Race Team", members: [member({ fullName: "<script>alert(1)</script>" })] },
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderRoster", () => {
  const groups: ProgramGroup[] = [{ programId: "p", programName: "Race Team", members: [member()] }];

  it("omits the filters when there is nothing to filter by", () => {
    const html = renderRoster({
      groups: [],
      teams: [],
      schools: [],
      filter: { team: null, school: null },
      shareToggles: [],
    });
    expect(html).not.toContain("roster-filters");
  });

  it("renders team and school filter selects with their options", () => {
    const html = renderRoster({
      groups,
      teams: [{ value: "J-Pod", label: "J-Pod" }],
      schools: [{ value: "lakeside", label: "Lakeside" }],
      filter: { team: null, school: null },
      shareToggles: [],
    });
    expect(html).toContain('id="roster-team-filter"');
    expect(html).toContain('<option value="J-Pod">J-Pod</option>');
    expect(html).toContain('id="roster-school-filter"');
    expect(html).toContain('<option value="lakeside">Lakeside</option>');
  });

  it("marks the active filter's option as selected", () => {
    const html = renderRoster({
      groups,
      teams: [{ value: "J-Pod", label: "J-Pod" }],
      schools: [],
      filter: { team: "J-Pod", school: null },
      shareToggles: [],
    });
    expect(html).toContain('<option value="J-Pod" selected>J-Pod</option>');
  });

  it("omits the share-toggle section when there are no writable registrations", () => {
    const html = renderRoster({
      groups,
      teams: [],
      schools: [],
      filter: { team: null, school: null },
      shareToggles: [],
    });
    expect(html).not.toContain("roster-share-toggle");
  });

  it("renders one checkbox per (person, program) row, labeled and checked", () => {
    const html = renderRoster({
      groups,
      teams: [],
      schools: [],
      filter: { team: null, school: null },
      shareToggles: [
        {
          personId: "person-1",
          programId: "prog-race",
          firstName: "Ada",
          programName: "Race Team",
          isSelf: true,
          checked: true,
          registrationIds: ["reg-1", "reg-2"],
        },
        {
          personId: "person-2",
          programId: "prog-race",
          firstName: "Bea",
          programName: "Race Team",
          isSelf: false,
          checked: false,
          registrationIds: ["reg-3"],
        },
      ],
    });
    expect(html).toContain("Share your contact info with your Race Team teammates");
    expect(html).toContain('data-registration-ids="reg-1,reg-2" checked');
    expect(html).toContain("Share your contact info with Bea's Race Team teammates");
    expect(html).toContain('data-registration-ids="reg-3" />');
  });
});

describe("renderRosterBlocked", () => {
  it("links to the sign-in URL", () => {
    const html = renderRosterBlocked("https://directus.example.com/auth/login/authentik?redirect=%2F");
    expect(html).toContain(
      '<a href="https://directus.example.com/auth/login/authentik?redirect=%2F">Sign in again</a>',
    );
  });
});

describe("buildVCard", () => {
  it("builds a vCard 3.0 block with FN, N, EMAIL, and TEL, CRLF-terminated", () => {
    const vcard = buildVCard({ fullName: "Ada Lovelace", email: "ada@example.com", phone: "555-1234" });
    expect(vcard.split("\r\n")).toEqual([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Ada Lovelace",
      "N:Lovelace;Ada;;;",
      "EMAIL:ada@example.com",
      "TEL:555-1234",
      "END:VCARD",
      "",
    ]);
  });

  it("omits EMAIL and TEL when there's nothing to put in them", () => {
    const vcard = buildVCard({ fullName: "Ada Lovelace", email: null, phone: null });
    expect(vcard).not.toContain("EMAIL:");
    expect(vcard).not.toContain("TEL:");
  });

  it("escapes a comma, semicolon, and backslash in a text value", () => {
    const vcard = buildVCard({ fullName: 'Jo "J" Doe, Jr; Esq\\', email: null, phone: null });
    expect(vcard).toContain('FN:Jo "J" Doe\\, Jr\\; Esq\\\\');
  });
});

describe("vCardDataUrl", () => {
  it("percent-encodes the vCard text into a downloadable data: URI", () => {
    const url = vCardDataUrl({ fullName: "Ada Lovelace", email: "ada@example.com", phone: null });
    expect(url.startsWith("data:text/vcard;charset=utf-8,")).toBe(true);
    const encoded = url.slice("data:text/vcard;charset=utf-8,".length);
    expect(decodeURIComponent(encoded)).toBe(
      buildVCard({ fullName: "Ada Lovelace", email: "ada@example.com", phone: null }),
    );
  });
});
