const { page } = require('./layout');

function render(ctx) {
  const { site, docs, renderMarkdown } = ctx;
  const body = renderMarkdown(
    docs.privacy || '# Privacy\n\nThis site measures aggregate traffic with Google Analytics and collects nothing else about its readers.'
  );
  const content = `<article class="doc">${body}</article>`;
  return page({
    site,
    assets: ctx.assets,
    route: '/privacy',
    title: 'Privacy',
    description:
      'BreachBook measures aggregate traffic with Google Analytics, which sets cookies, and collects nothing else about its readers: no advertising, no accounts.',
    content,
  });
}

module.exports = { render };
