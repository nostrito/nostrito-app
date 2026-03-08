/** DMs — Direct Messages screen matching the landing page demo */

const DM_CONTACTS = [
  { id: "fiatjaf", name: "fiatjaf", avatar: "F", avClass: "av1", hop: 1, preview: "Have you tried the new relay config? It's way faster now", time: "3m ago", unread: true },
  { id: "jb55", name: "jb55", avatar: "J", avClass: "av2", hop: 1, preview: "notedeck integration is looking solid 🔥", time: "1h ago", unread: false },
  { id: "lynalden", name: "Lynalden", avatar: "L", avClass: "av5", hop: 2, preview: "Thanks for the article recommendation, really insightful", time: "3h ago", unread: false },
  { id: "odell", name: "ODELL", avatar: "O", avClass: "av3", hop: 1, preview: "Let's do a citadel dispatch episode on personal relays", time: "5h ago", unread: false },
  { id: "gigi", name: "Gigi", avatar: "G", avClass: "av4", hop: 1, preview: "The sovereignty angle is exactly right. Ship it.", time: "1d ago", unread: false },
];

export function renderDms(container: HTMLElement): void {
  container.className = "main-content";
  container.innerHTML = `
    <div class="dms-page-inner">
      <div class="dm-list" id="dmList">
        ${DM_CONTACTS.map(c => `
          <div class="dm-item" data-dm="${c.id}" ${c.unread ? 'style="padding-left:28px"' : ''}>
            ${c.unread ? '<div class="dm-unread-dot"></div>' : ''}
            <div class="dm-avatar ${c.avClass}">${c.avatar}</div>
            <div class="dm-info">
              <div class="dm-name-row">
                <span class="dm-name">${c.name}</span>
                <span class="wot-hop-badge wot-hop-${c.hop}">${c.hop}-hop</span>
              </div>
              <div class="dm-preview">${c.preview}</div>
            </div>
            <span class="dm-time">${c.time}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Wire DM clicks (placeholder — no conversation view yet in real app)
  container.querySelectorAll('.dm-item').forEach(item => {
    item.addEventListener('click', () => {
      container.querySelectorAll('.dm-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    });
  });
}
