'use strict';
/**
 * win-toast.js — a Windows toast notification from a background process, with no console window.
 * The PowerShell that raises it is spawned with windowsHide (CREATE_NO_WINDOW), never a visible
 * window. `CCB_TOAST_SINK` names a file that also receives every toast as one JSON line, so a run
 * can prove what the user was shown; `CCB_TOAST_DRY=1` records without showing.
 */
const fs = require('fs');
const path = require('path');

const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const b64 = (s) => Buffer.from(String(s).replace(CONTROL_CHARS, ' '), 'utf8').toString('base64');

/**
 * The PowerShell script that raises one toast. The text never appears in the script as code: it
 * travels as base64 and is set as the text of the XML nodes, so no quote or markup in it can end
 * a string or open an element.
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function toastScript(title, body) {
  const text = (s) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;
  return [
    "$ErrorActionPreference='Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$d = New-Object Windows.Data.Xml.Dom.XmlDocument',
    "$d.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text/><text/></binding></visual></toast>')",
    '$n = $d.GetElementsByTagName(\'text\')',
    `$n.Item(0).InnerText = ${text(title)}`,
    `$n.Item(1).InnerText = ${text(body)}`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($d))`,
  ].join('; ');
}

/**
 * Show a toast and record it. Never throws: a notification that cannot be shown is reported in the result.
 * @param {{title:string, body:string}} toast
 * @param {{env?:object, platform?:string, spawn?:Function, now?:()=>number}} [deps]
 * @returns {{shown:boolean, recorded:boolean, error?:string}}
 */
function toast({ title, body }, deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const out = { shown: false, recorded: false };
  const sink = env.CCB_TOAST_SINK;
  if (sink) {
    try {
      fs.mkdirSync(path.dirname(sink), { recursive: true });
      fs.appendFileSync(sink, `${JSON.stringify({ at: (deps.now || Date.now)(), title, body })}\n`);
      out.recorded = true;
    } catch (err) { out.error = `toast sink not written: ${err.message}`; }
  }
  if (env.CCB_TOAST_DRY === '1') return out;
  if (platform !== 'win32') { out.error = out.error || 'toasts are only raised on Windows'; return out; }
  try {
    const spawn = deps.spawn || require('child_process').spawn;
    const encoded = Buffer.from(toastScript(title, body), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore', detached: true });
    if (child && typeof child.unref === 'function') child.unref();
    out.shown = true;
  } catch (err) { out.error = `toast not raised: ${err.message}`; }
  return out;
}

module.exports = { toast, toastScript };
