function buildTargetUrl(baseUrl, reqPathname) {
  const base = baseUrl.replace(/\/+$/, "");
  if (reqPathname.startsWith("/v1/")) {
    return `${base}${reqPathname}`;
  }
  return `${base}${reqPathname}`;
}

export async function forwardRequest({
  baseUrl,
  pathname,
  body,
  headers
}) {
  const targetUrl = buildTargetUrl(baseUrl, pathname);
  const upstream = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  return upstream;
}
