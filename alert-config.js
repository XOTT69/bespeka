// Alert API adapter. Do not commit secret API keys to a public repository.
// Send the API docs / sample response and this file can be tailored exactly.
window.BESPEKA_ALERT_API = null;

/* Example for a public endpoint without secrets:
window.BESPEKA_ALERT_API = {
  url: 'https://example.com/alerts/kyiv-region',
  headers: {},
  parse(data) {
    return { active: Boolean(data.active), text: data.active ? 'Київська область' : 'Київська область' };
  }
};
*/
