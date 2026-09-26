let loginPin = '';

function showError(message) {
  const errorMsg = document.getElementById('errorMsg');
  errorMsg.textContent = message;
  errorMsg.style.display = message ? 'block' : 'none';
}

function errorText(err) {
  return window.UiMessages.userMessage(err);
}

function showSection(id) {
  for (const section of ['loginSection', 'setupSection', 'changePinSection']) {
    document.getElementById(section).style.display = section === id ? 'block' : 'none';
  }
  showError('');
}

async function attemptLogin() {
  const username = document.getElementById('username').value.trim();
  const pin = document.getElementById('pin').value.trim();

  let user;
  try {
    user = await window.api.auth.login(username, pin);
  } catch (err) {
    showError(errorText(err));
    return;
  }
  if (!user) {
    showError('اسم المستخدم أو الرقم السري غير صحيح');
    return;
  }
  if (user.mustChangePin) {
    loginPin = pin;
    showSection('changePinSection');
    document.getElementById('newPin').focus();
    return;
  }
  await window.api.nav.goToApp();
}

async function submitSetup() {
  const storeName = document.getElementById('setupStoreName').value.trim();
  const currency = document.getElementById('setupCurrency').value.trim();
  const username = document.getElementById('setupUsername').value.trim();
  const pin = document.getElementById('setupPin').value;
  if (!storeName) {
    showError('اسم المتجر مطلوب');
    return;
  }
  if (pin !== document.getElementById('setupPinConfirm').value) {
    showError('الرقم السري وتأكيده غير متطابقين');
    return;
  }
  try {
    await window.api.auth.setupAdmin(username, pin, { storeName, currency });
  } catch (err) {
    showError(errorText(err));
    return;
  }
  await window.api.nav.goToApp();
}

async function submitPinChange() {
  const newPin = document.getElementById('newPin').value;
  if (newPin !== document.getElementById('newPinConfirm').value) {
    showError('الرقم السري وتأكيده غير متطابقين');
    return;
  }
  try {
    await window.api.auth.changePin(loginPin, newPin);
  } catch (err) {
    showError(errorText(err));
    return;
  }
  loginPin = '';
  await window.api.nav.goToApp();
}

document.getElementById('loginBtn').addEventListener('click', attemptLogin);
document.getElementById('pin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptLogin();
});
document.getElementById('setupBtn').addEventListener('click', submitSetup);
document.getElementById('changePinBtn').addEventListener('click', submitPinChange);

window.api.auth.needsSetup().then((needsSetup) => {
  if (needsSetup) {
    showSection('setupSection');
    document.getElementById('setupStoreName').focus();
  }
});
