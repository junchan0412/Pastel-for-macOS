import plist from 'plist';
import {storeLogin, curlRequest, parsePlistLoose, STORE_USER_AGENT, cleanup} from './gsa.js';
import {getDeviceGuid} from './device.js';
import {t} from './i18n.js';

class ApiError extends Error {
    constructor(message, failureType, customerMessage) {
        super(message);
        this.name = 'ApiError';
        this.failureType = failureType;
        this.customerMessage = customerMessage;
        if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
    }
}

function podPrefix(pod) {
    return pod ? `p${pod}-` : '';
}

function tokenExpiredError() {
    const e = new Error('password token is expired');
    e.code = 'TOKEN_EXPIRED';
    return e;
}

function isPasswordTokenExpiredMessage(message) {
    return /Your password has changed\.?|password token is expired/i.test(String(message || ''));
}

// ipaverse treats these StoreServices failures as authentication/session
// failures. Apple does not consistently include an English error message, so
// relying on customerMessage alone leaves some expired sessions undetected.
const AUTH_FAILURE_TYPES = new Set(['-5000', '1008', '2002', '2034', '2042']);

export function isAuthFailureResponse(failureType, customerMessage, statusCode = 200) {
    return statusCode === 401
        || statusCode === 403
        || AUTH_FAILURE_TYPES.has(String(failureType || ''))
        || isPasswordTokenExpiredMessage(customerMessage);
}

export function appInfoFailureCode(failureType, customerMessage) {
    const type = String(failureType || '');
    const message = String(customerMessage || '').replace(/\u00a0/g, ' ');
    if (type === '9610') return 'LICENSE_NOT_FOUND';
    if (type === '2059') return 'APPINFO_BUSY';
    if (/License not found|Redownload Unavailable with This Apple Account/i.test(message)) {
        return 'LICENSE_NOT_FOUND';
    }
    return type || customerMessage ? 'APPINFO_FAIL' : '';
}

export function purchaseSuccessKind(response) {
    const failureType = String(response?.failureType || '');
    const customerMessage = String(response?.customerMessage || '').replace(/\u00a0/g, ' ');

    // buyProduct is idempotent for an App already in the account library, but
    // failureType 5002 is also used for unrelated StoreServices failures. Only
    // accept it when Apple explicitly says that the license already exists.
    if (failureType === '5002'
        && /License already exists|already (?:in (?:your|the) library|owned|purchased)/i.test(customerMessage)) {
        return 'existing';
    }

    // Match ApplePackage's strict purchase contract. HTTP 500, status=0 by
    // itself, or a failureType must never be promoted to a successful purchase.
    if (!failureType
        && response?._httpStatus === 200
        && response?.jingleDocType === 'purchaseSuccess'
        && response?.status === 0) {
        return 'new';
    }
    return '';
}

function downloadVersionError(response, appVerId) {
    const song = response?.songList?.[0];
    if (!appVerId) return null;
    const actual = String(song?.metadata?.softwareVersionExternalIdentifier
        ?? song?.softwareVersionExternalIdentifier ?? '');
    if (actual === String(appVerId)) return null;
    const error = new Error(t('appinfo_version_mismatch', {expected: appVerId, actual: actual || '?'}));
    error.code = 'APPINFO_VERSION_MISMATCH';
    return error;
}

const _endpoints = {
    AppInfo: {
        url: (guid, pod) => `https://${podPrefix(pod)}buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=${guid}`,
        buildBody: ({appIdentifier, appVerId, guid, redownload = false}) => ({
            creditDisplay: '',
            guid,
            salableAdamId: appIdentifier,
            ...(!redownload && {serialNumber: '0'}),
            ...(appVerId && {[redownload ? 'appExtVrsId' : 'externalVersionId']: appVerId}),
        }),
    },
    Redownload: {
        url: (guid) => `https://downloaddispatch.itunes.apple.com/r/redownload?guid=${guid}`,
    },
    // bag.xml urlBag.updateProduct：ipatool 只在**固定了历史版本**且 redownload 返回
    // 空 / “No longer available” 时调用它（appExtVrsId），这是取回指定历史版本的关键兜底。
    Update: {
        url: (guid) => `https://downloaddispatch.itunes.apple.com/up/updateProduct?guid=${guid}`,
    },
    // bag.xml urlBag.backgroundUpdateProduct：IPA-Tool-3.0 在 songList 仍为空时的最后兜底。
    BackgroundUpdate: {
        url: (guid) => `https://downloaddispatch.itunes.apple.com/up/backgroundUpdateProduct?guid=${guid}`,
    },
    purchase: {
        url: (pod) => `https://${podPrefix(pod)}buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct`,
        buildBody: ({appid, appVerId, guid, pricingParameters = 'STDQ'}) => ({
            appExtVrsId: appVerId || '0',
            buyWithoutAuthorization: 'true',
            hasAskedToFulfillPreorder: 'true',
            hasDoneAgeCheck: 'true',
            guid,
            needDiv: '0',
            origPage: `Software-${appid}`,
            origPageLocation: 'Buy',
            price: '0',
            pricingParameters,
            productType: 'C',
            salableAdamId: appid,
        }),
    },
};

// 判断某端点没有给出可用下载信息：Apple 对部分第三方 App 返回 5002，
// 近期也会返回 status=0 + 空 songList —— 这两种都要换端点重试。
function needsDownloadFallback(parsedResp) {
    return String(parsedResp.failureType || '') === '5002' || !parsedResp.songList?.[0];
}

// 取下载信息的端点链（对齐两份参考实现，顺序与触发条件固定如下）：
//   volumeStore → redownload → (仅固定版本) updateProduct → backgroundUpdate
//   - volumeStore：ipatool 首选；固定版本时键为 externalVersionId
//   - redownload：ipatool / Asspp 对 5002 的兼容路径（键 appExtVrsId）
//   - updateProduct：ipatool **只在固定了历史版本**时调用，用于取回指定历史版本
//   - backgroundUpdate：IPA-Tool-3.0 在 songList 仍为空时的最后兜底
export function downloadInfoCandidates({appIdentifier, appVerId = '', guid = '', pod = ''} = {}) {
    const endpoint = _endpoints.AppInfo;
    const body = {appIdentifier, appVerId, guid};
    const appExtBody = endpoint.buildBody({...body, redownload: true});
    return [
        {name: 'volumeStore', url: endpoint.url(guid, pod), body: endpoint.buildBody(body)},
        {name: 'redownload', url: _endpoints.Redownload.url(guid), body: appExtBody},
        ...(appVerId
            ? [{name: 'updateProduct', url: _endpoints.Update.url(guid), body: appExtBody}]
            : []),
        {name: 'backgroundUpdate', url: _endpoints.BackgroundUpdate.url(guid), body: appExtBody},
    ];
}

class Store {
    static get guid() {
        return getDeviceGuid();
    }

    static cleanup() {
        cleanup();
    }

    // 与 Asspp 一样直接使用 StoreServices 登录；此活动路径不调用
    // GSA/Anisette，因此不会创建模拟 Mac 设备记录。
    static async login(email, password, mfa, previousSession = null) {
        try {
            return await storeLogin(email, password, mfa, this.guid, previousSession?.cookieText || '', previousSession?.pod || '');
        } catch (error) {
            const msg = error.message || String(error);
            if (error.code === 'AUTH_OR_2FA') {
                const e = new Error(t('login_auth_or_2fa'));
                e.code = 'AUTH_OR_2FA';
                throw e;
            }
            // 2FA 检测用稳定的 error.code（不依赖文案语言）；保留中文 includes 作为兜底。
            if (error.code === 'NEEDS_2FA' || msg.includes('需要双重验证码')) {
                const e = new Error(t('login_2fa'));
                e.code = 'NEEDS_2FA';
                throw e;
            }
            throw new Error(t('login_auth_failed', {msg}));
        }
    }

    // 调用 StoreServices 私有接口（volumeStoreDownloadProduct / buyProduct），经系统代理走 curl，
    // 并复用 authenticate 阶段种下的会话 cookie（volumeStoreDownloadProduct 依赖该会话）。
    static #storePost(prefix, url, bodyObj, headers, authContext) {
        const body = plist.build(bodyObj);
        let res = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            res = curlRequest('POST', url, {headers, body, follow: true, timeout: 60, jar: authContext?.cookieJar || null});
            if (res.status !== 0) break;
        }
        if (!res || res.status === 0) {
            const e = new Error(`${prefix}${t('net_failed_suffix')}`);
            e.code = 'STORE_FAIL';
            throw e;
        }
        if (isAuthFailureResponse('', '', res.status)) throw tokenExpiredError();
        try {
            return {...parsePlistLoose(res.body, t('ctx_resp')), _httpStatus: res.status};
        } catch (error) {
            const e = new Error(`${prefix}${t('bad_format_suffix', {message: error.message})}`);
            e.code = 'STORE_FAIL';
            throw e;
        }
    }

    static async AppInfo(appIdentifier, appVerId, authContext, {listVersions = false} = {}) {
        const endpoint = _endpoints.AppInfo;
        const dsid = authContext?.authHeaders?.['X-Dsid'];
        // 与 ipatool 一致：下载信息请求仅带 DSID 头 + 会话 cookie（不带 X-Token / storefront）。
        const headers = {
            'User-Agent': STORE_USER_AGENT,
            'Content-Type': 'application/x-apple-plist',
            'iCloud-DSID': dsid,
            'X-Dsid': dsid,
        };
        const candidates = downloadInfoCandidates({
            appIdentifier,
            appVerId,
            guid: this.guid,
            pod: authContext?.pod,
        });

        let parsedResp = null;
        let lastFailure = null;
        for (const [index, candidate] of candidates.entries()) {
            const isLast = index === candidates.length - 1;
            let resp;
            try {
                resp = this.#storePost(t('label_download_app'), candidate.url, candidate.body, headers, authContext);
            } catch (error) {
                // 认证失效立刻上抛（交给上层重登）；其它端点异常先换下一个，末个候选才传播。
                if (error?.code === 'TOKEN_EXPIRED' || isLast) throw error;
                lastFailure = error;
                continue;
            }
            parsedResp = resp;

            // 可立即判定的信号不浪费后续请求：认证失效、服务器繁忙、缺许可。
            if (isAuthFailureResponse(resp.failureType, resp.customerMessage)) break;
            const failureCode = appInfoFailureCode(resp.failureType, resp.customerMessage);
            if (failureCode === 'APPINFO_BUSY' || failureCode === 'LICENSE_NOT_FOUND') break;
            // 只有末个候选的 customerMessage 才对外抛出，中间端点的
            // “No longer available”/5002 属于可继续尝试的空响应（语义与旧实现一致）。
            if (isLast) break;
            if (needsDownloadFallback(resp) || (appVerId && !resp.songList[0].URL) || downloadVersionError(resp, appVerId)) continue;
            break;
        }

        if (!parsedResp) {
            if (lastFailure) throw lastFailure;
            const empty = new Error(t('appinfo_nodata'));
            empty.code = listVersions ? 'APPINFO_EMPTY' : 'APPINFO_FAIL';
            throw empty;
        }

        const failureCode = appInfoFailureCode(parsedResp.failureType, parsedResp.customerMessage);
        if (failureCode === 'APPINFO_BUSY') {
            const e = new Error(t('appinfo_busy'));
            e.code = failureCode;
            throw e;
        }
        if (isAuthFailureResponse(parsedResp.failureType, parsedResp.customerMessage)) {
            throw tokenExpiredError();
        }
        if (parsedResp.customerMessage || failureCode === 'LICENSE_NOT_FOUND') {
            const e = new Error(t('appinfo_custom', {msg: parsedResp.customerMessage || parsedResp.failureType}));
            e.code = failureCode;
            throw e;
        }
        if (!parsedResp.songList?.[0]) {
            const e = new Error(t('appinfo_nodata'));
            // Apple sometimes reports an unowned free App as status=0 with an empty songList instead
            // of failureType=9610. Only the version-list path may interpret that response as a
            // missing license candidate.
            e.code = listVersions ? 'APPINFO_EMPTY' : 'APPINFO_FAIL';
            throw e;
        }
        const versionError = downloadVersionError(parsedResp, appVerId);
        if (versionError) throw versionError;
        if (appVerId && !parsedResp.songList[0].URL) {
            const error = new Error(t('appinfo_nodata'));
            error.code = 'APPINFO_FAIL';
            throw error;
        }
        return parsedResp;
    }

    static async purchase(appid, appVerId, authContext) {
        const endpoint = _endpoints.purchase;
        const url = endpoint.url(authContext?.pod);
        // 对齐 ipatool：只有 2059（暂时不可用）才使用 Apple Arcade 的 GAME 参数重试。
        const headers = {
            'User-Agent': STORE_USER_AGENT,
            'Content-Type': 'application/x-apple-plist',
            ...(authContext?.authHeaders || {}),
        };
        for (const pricingParameters of ['STDQ', 'GAME']) {
            const parsedResp = this.#storePost(t('label_purchase'), url, endpoint.buildBody({appid, appVerId, guid: this.guid, pricingParameters}), headers, authContext);
            const successKind = purchaseSuccessKind(parsedResp);
            if (successKind) {
                const versionError = successKind === 'new' && downloadVersionError(parsedResp, appVerId);
                if (versionError) throw versionError;
                const isExisting = successKind === 'existing';
                const message = isExisting ? t('lic_in_library') : t('lic_new');
                // _existing 由 successKind 直接给出，避免用已本地化的 customerMessage 反猜语义
                //（ja/ko/th 的“已存在”文案不含 library/资料库 关键词，反猜会判错）。
                return {...parsedResp, _state: 'success', _existing: isExisting, customerMessage: message};
            }
            if (isAuthFailureResponse(parsedResp.failureType, parsedResp.customerMessage)) {
                throw tokenExpiredError();
            }
            if (parsedResp.failureType === '2059' && pricingParameters === 'STDQ') {
                continue;
            }
            const e = new Error(t('license_failed', {msg: parsedResp.customerMessage || parsedResp.failureType || t('lic_fail_msg')}));
            e.code = 'LICENSE_FAIL';
            throw e;
        }
        const e = new Error(t('license_failed', {msg: t('lic_fail_msg')}));
        e.code = 'LICENSE_FAIL';
        throw e;
    }
}

export {Store};
