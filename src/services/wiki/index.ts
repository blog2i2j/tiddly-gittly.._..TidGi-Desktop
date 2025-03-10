/* eslint-disable @typescript-eslint/strict-boolean-expressions */
/* eslint-disable @typescript-eslint/no-misused-promises */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-dynamic-delete */
import { dialog, shell } from 'electron';
import { backOff } from 'exponential-backoff';
import { copy, createSymlink, exists, mkdir, mkdirp, mkdirs, pathExists, readFile, remove } from 'fs-extra';
import { injectable } from 'inversify';
import path from 'path';
import { ModuleThread, spawn, Thread, Worker } from 'threads';
import type { WorkerEvent } from 'threads/dist/types/master';

import { WikiChannel } from '@/constants/channels';
import { TIDDLERS_PATH, TIDDLYWIKI_PACKAGE_FOLDER, TIDDLYWIKI_TEMPLATE_FOLDER_PATH } from '@/constants/paths';
import type { IAuthenticationService } from '@services/auth/interface';
import { lazyInject } from '@services/container';
import type { IGitService, IGitUserInfos } from '@services/git/interface';
import { i18n } from '@services/libs/i18n';
import { getWikiErrorLogFileName, logger, startWikiLogger } from '@services/libs/log';
import serviceIdentifier from '@services/serviceIdentifier';
import type { IViewService } from '@services/view/interface';
import type { IWindowService } from '@services/windows/interface';
import { WindowNames } from '@services/windows/WindowProperties';
import type { IWorkspace, IWorkspaceService } from '@services/workspaces/interface';
import type { IWorkspaceViewService } from '@services/workspacesView/interface';
import { Observable } from 'rxjs';
import type { IChangedTiddlers } from 'tiddlywiki';
import { AlreadyExistError, CopyWikiTemplateError, DoubleWikiInstanceError, HTMLCanNotLoadError, SubWikiSMainWikiNotExistError, WikiRuntimeError } from './error';
import { IWikiService, WikiControlActions } from './interface';
import { getSubWikiPluginContent, ISubWikiPluginContent, updateSubWikiPluginContent } from './plugin/subWikiPlugin';
import type { IStartNodeJSWikiConfigs, WikiWorker } from './wikiWorker';
import type { IpcServerRouteMethods, IpcServerRouteNames } from './wikiWorker/ipcServerRoutes';

// @ts-expect-error it don't want .ts
// eslint-disable-next-line import/no-webpack-loader-syntax
import workerURL from 'threads-plugin/dist/loader?name=wikiWorker!./wikiWorker/index.ts';

import { LOG_FOLDER } from '@/constants/appPaths';
import { isDevelopmentOrTest } from '@/constants/environment';
import { isHtmlWiki } from '@/constants/fileNames';
import { defaultServerIP } from '@/constants/urls';
import { IDatabaseService } from '@services/database/interface';
import { IPreferenceService } from '@services/preferences/interface';
import { ISyncService } from '@services/sync/interface';
import { mapValues } from 'lodash';
import { wikiWorkerStartedEventName } from './constants';
import { IWorkerWikiOperations } from './wikiOperations/executor/wikiOperationInServer';
import { getSendWikiOperationsToBrowser, ISendWikiOperationsToBrowser } from './wikiOperations/sender/sendWikiOperationsToBrowser';

@injectable()
export class Wiki implements IWikiService {
  @lazyInject(serviceIdentifier.Preference)
  private readonly preferenceService!: IPreferenceService;

  @lazyInject(serviceIdentifier.Authentication)
  private readonly authService!: IAuthenticationService;

  @lazyInject(serviceIdentifier.Database)
  private readonly databaseService!: IDatabaseService;

  @lazyInject(serviceIdentifier.Window)
  private readonly windowService!: IWindowService;

  @lazyInject(serviceIdentifier.Git)
  private readonly gitService!: IGitService;

  @lazyInject(serviceIdentifier.Workspace)
  private readonly workspaceService!: IWorkspaceService;

  @lazyInject(serviceIdentifier.View)
  private readonly viewService!: IViewService;

  @lazyInject(serviceIdentifier.WorkspaceView)
  private readonly workspaceViewService!: IWorkspaceViewService;

  @lazyInject(serviceIdentifier.Sync)
  private readonly syncService!: ISyncService;

  public async getSubWikiPluginContent(mainWikiPath: string): Promise<ISubWikiPluginContent[]> {
    return await getSubWikiPluginContent(mainWikiPath);
  }

  // handlers
  public async copyWikiTemplate(newFolderPath: string, folderName: string): Promise<void> {
    try {
      await this.createWiki(newFolderPath, folderName);
    } catch (error) {
      throw new CopyWikiTemplateError(`${(error as Error).message}, (${newFolderPath}, ${folderName})`);
    }
  }

  // key is same to workspace id, so we can get this worker by workspace id
  // { [id: string]: ArbitraryThreadType }
  private wikiWorkers: Partial<Record<string, ModuleThread<WikiWorker>>> = {};
  public getWorker(id: string): ModuleThread<WikiWorker> | undefined {
    return this.wikiWorkers[id];
  }

  private readonly wikiWorkerStartedEventTarget = new EventTarget();

  public async startWiki(workspaceID: string, userName: string): Promise<void> {
    if (workspaceID === undefined) {
      logger.error('Try to start wiki, but workspace ID not provided', { workspaceID });
      return;
    }
    const previousWorker = this.getWorker(workspaceID);
    if (previousWorker !== undefined) {
      logger.error(new DoubleWikiInstanceError(workspaceID).message, { stack: new Error('stack').stack?.replace('Error:', '') ?? 'no stack' });
      await this.stopWiki(workspaceID);
    }
    // use Promise to handle worker callbacks
    const workspace = await this.workspaceService.get(workspaceID);
    if (workspace === undefined) {
      logger.error('Try to start wiki, but workspace not found', { workspace, workspaceID });
      return;
    }
    const { port, rootTiddler, readOnlyMode, tokenAuth, homeUrl, lastUrl, https, excludedPlugins, isSubWiki, wikiFolderLocation, name, enableHTTPAPI, authToken } = workspace;
    if (isSubWiki) {
      logger.error('Try to start wiki, but workspace is sub wiki', { workspace, workspaceID });
      return;
    }
    // wiki server is about to boot, but our webview is just start loading, wait for `view.webContents.on('did-stop-loading'` to set this to false
    await this.workspaceService.updateMetaData(workspaceID, { isLoading: true });
    if (tokenAuth && authToken) {
      logger.debug(`startWiki() getOneTimeAdminAuthTokenForWorkspaceSync because tokenAuth is ${String(tokenAuth)} && authToken is ${authToken}`);
    }
    const workerData: IStartNodeJSWikiConfigs = {
      authToken,
      constants: { TIDDLYWIKI_PACKAGE_FOLDER },
      enableHTTPAPI,
      excludedPlugins,
      homePath: wikiFolderLocation,
      https,
      isDev: isDevelopmentOrTest,
      openDebugger: process.env.DEBUG_WORKER === 'true',
      readOnlyMode,
      rootTiddler,
      tiddlyWikiHost: defaultServerIP,
      tiddlyWikiPort: port,
      tokenAuth,
      userName,
    };
    logger.debug(`initial wikiWorker with  ${workerURL as string} for workspaceID ${workspaceID}`, { function: 'Wiki.startWiki' });
    const worker = await spawn<WikiWorker>(new Worker(workerURL as string), { timeout: 1000 * 60 });
    logger.debug(`initial wikiWorker done`, { function: 'Wiki.startWiki' });
    this.wikiWorkers[workspaceID] = worker;
    this.wikiWorkerStartedEventTarget.dispatchEvent(new Event(wikiWorkerStartedEventName(workspaceID)));
    const wikiLogger = startWikiLogger(workspaceID, name);
    const loggerMeta = { worker: 'NodeJSWiki', homePath: wikiFolderLocation };
    await new Promise<void>((resolve, reject) => {
      // handle native messages
      Thread.errors(worker).subscribe(async (error) => {
        wikiLogger.error(error.message, { function: 'Thread.errors' });
        reject(new WikiRuntimeError(error, name, false));
      });
      Thread.events(worker).subscribe((event: WorkerEvent) => {
        // can't import WorkerEventType from 'threads/dist/types/master' because it's causing error
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
        if (event.type === 'message') {
          wikiLogger.info('', {
            ...mapValues(
              event.data,
              (value: unknown) => typeof value === 'string' ? (value.length > 200 ? `${value.substring(0, 200)}... (substring(0, 200))` : value) : String(value),
            ),
          });
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
        } else if (event.type === 'termination') {
          delete this.wikiWorkers[workspaceID];
          const warningMessage = `NodeJSWiki ${workspaceID} Worker stopped (can be normal quit, or unexpected error, see other logs to determine)`;
          logger.info(warningMessage, loggerMeta);
          logger.info(`startWiki() rejected with message.type === 'message' and event.type === 'termination'`, loggerMeta);
          resolve();
        }
      });

      // subscribe to the Observable that startNodeJSWiki returns, handle messages send by our code
      logger.debug('startWiki calling startNodeJSWiki in the main process', { function: 'wikiWorker.startNodeJSWiki' });
      worker.startNodeJSWiki(workerData).subscribe(async (message) => {
        if (message.type === 'control') {
          await this.workspaceService.update(workspaceID, { lastNodeJSArgv: message.argv }, true);
          switch (message.actions) {
            case WikiControlActions.booted: {
              setTimeout(async () => {
                logger.info(`startWiki() resolved with message.type === 'control' and WikiControlActions.booted`, { ...loggerMeta, message: message.message, workspaceID });
                resolve();
              }, 100);
              break;
            }
            case WikiControlActions.start: {
              if (message.message !== undefined) {
                logger.debug('WikiControlActions.start', { 'message.message': message.message, ...loggerMeta, workspaceID });
              }
              break;
            }
            case WikiControlActions.listening: {
              // API server started, but we are using IPC to serve content now, so do nothing here.
              if (message.message !== undefined) {
                logger.info('WikiControlActions.listening ' + message.message, { ...loggerMeta, workspaceID });
              }
              break;
            }
            case WikiControlActions.error: {
              const errorMessage = message.message ?? 'get WikiControlActions.error without message';
              logger.error(`startWiki() rejected with message.type === 'control' and  WikiControlActions.error`, { ...loggerMeta, message, errorMessage, workspaceID });
              await this.workspaceService.updateMetaData(workspaceID, { isLoading: false, didFailLoadErrorMessage: errorMessage });
              // fix "message":"listen EADDRINUSE: address already in use 0.0.0.0:5212"
              if (errorMessage.includes('EADDRINUSE')) {
                const portChange = {
                  port: port + 1,
                  homeUrl: homeUrl.replace(`:${port}`, `:${port + 1}`),
                  // eslint-disable-next-line unicorn/no-null
                  lastUrl: lastUrl?.replace?.(`:${port}`, `:${port + 1}`) ?? null,
                };
                await this.workspaceService.update(workspaceID, portChange, true);
                reject(new WikiRuntimeError(new Error(message.message), wikiFolderLocation, true, { ...workspace, ...portChange }));
                return;
              }
              reject(new WikiRuntimeError(new Error(message.message), wikiFolderLocation, false, { ...workspace }));
            }
          }
        } else if (message.type === 'stderr' || message.type === 'stdout') {
          wikiLogger.info(message.message, { function: 'startNodeJSWiki' });
        }
      });
    });
    void this.afterWikiStart(workspaceID);
  }

  private async afterWikiStart(workspaceID: string): Promise<void> {
    const workspace = await this.workspaceService.get(workspaceID);
    if (workspace === undefined) {
      logger.error('afterWikiStart() get workspace failed', { workspaceID });
      return;
    }
    const { isSubWiki, enableHTTPAPI } = workspace;
    if (!isSubWiki && enableHTTPAPI) {
      // Auto enable server filters if HTTP API is enabled. So this feature immediately available to 3rd party apps, reduce user confusion.
      await this.wikiOperationInServer(WikiChannel.addTiddler, workspaceID, [
        '$:/config/Server/AllowAllExternalFilters',
        'yes',
      ]);
    }
  }

  /**
   * Ensure you get a started worker. If not stated, it will await for it to start.
   * @param workspaceID
   */
  private async getWorkerEnsure(workspaceID: string): Promise<ModuleThread<WikiWorker>> {
    let worker = this.getWorker(workspaceID);
    if (worker === undefined) {
      // wait for wiki worker started
      await new Promise<void>(resolve => {
        this.wikiWorkerStartedEventTarget.addEventListener(wikiWorkerStartedEventName(workspaceID), () => {
          resolve();
        });
      });
    } else {
      return worker;
    }
    worker = this.getWorker(workspaceID);
    if (worker === undefined) {
      const errorMessage =
        `Still no wiki for ${workspaceID} after wikiWorkerStartedEventTarget.addEventListener(wikiWorkerStartedEventName. No running worker, maybe tiddlywiki server in this workspace failed to start`;
      logger.error(
        errorMessage,
        {
          function: 'getWorkerEnsure',
        },
      );
      throw new Error(errorMessage);
    }
    return worker;
  }

  public async callWikiIpcServerRoute<NAME extends IpcServerRouteNames>(workspaceID: string, route: NAME, ...arguments_: Parameters<IpcServerRouteMethods[NAME]>) {
    // don't log full `arguments_` here, it might contains huge text
    logger.debug(`callWikiIpcServerRoute get ${route}`, { workspaceID });
    const worker = await this.getWorkerEnsure(workspaceID);
    logger.debug(`callWikiIpcServerRoute got worker`);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
    // @ts-ignore Argument of type 'string | string[] | ITiddlerFields | undefined' is not assignable to parameter of type 'string'. Type 'undefined' is not assignable to type 'string'.ts(2345)
    const response = await worker[route](...arguments_);
    logger.debug(`callWikiIpcServerRoute returning response`, { route, code: response.statusCode });
    return response;
  }

  public getWikiChangeObserver$(workspaceID: string): Observable<IChangedTiddlers> {
    return new Observable((observer) => {
      const getWikiChangeObserverIIFE = async () => {
        const worker = await this.getWorkerEnsure(workspaceID);
        const observable = worker.getWikiChangeObserver();
        observable.subscribe(observer);
      };
      void getWikiChangeObserverIIFE();
    });
  }

  public async extractWikiHTML(htmlWikiPath: string, saveWikiFolderPath: string): Promise<string | undefined> {
    // hope saveWikiFolderPath = ParentFolderPath + wikifolderPath
    // We want the folder where the WIKI is saved to be empty, and we want the input htmlWiki to be an HTML file even if it is a non-wikiHTML file. Otherwise the program will exit abnormally.
    const worker = await spawn<WikiWorker>(new Worker(workerURL as string), { timeout: 1000 * 60 });
    try {
      if (!isHtmlWiki(htmlWikiPath)) {
        throw new HTMLCanNotLoadError(htmlWikiPath);
      }
      if (await exists(saveWikiFolderPath)) {
        throw new AlreadyExistError(saveWikiFolderPath);
      }
      await worker.extractWikiHTML(htmlWikiPath, saveWikiFolderPath, { TIDDLYWIKI_PACKAGE_FOLDER });
    } catch (error) {
      const result = `${(error as Error).name} ${(error as Error).message}`;
      logger.error(result, { worker: 'NodeJSWiki', method: 'extractWikiHTML', htmlWikiPath, saveWikiFolderPath });
      return result;
    }
    // this worker is only for one time use. we will spawn a new one for starting wiki later.
    await Thread.terminate(worker);
  }

  public async packetHTMLFromWikiFolder(wikiFolderLocation: string, pathOfNewHTML: string): Promise<void> {
    const worker = await spawn<WikiWorker>(new Worker(workerURL as string), { timeout: 1000 * 60 });
    await worker.packetHTMLFromWikiFolder(wikiFolderLocation, pathOfNewHTML, { TIDDLYWIKI_PACKAGE_FOLDER });
    // this worker is only for one time use. we will spawn a new one for starting wiki later.
    await Thread.terminate(worker);
  }

  public async stopWiki(id: string): Promise<void> {
    const worker = this.getWorker(id);
    if (worker === undefined) {
      logger.warn(`No wiki for ${id}. No running worker, means maybe tiddlywiki server in this workspace failed to start`, {
        function: 'stopWiki',
        stack: new Error('stack').stack?.replace('Error:', '') ?? 'no stack',
      });
      return;
    }
    this.syncService.stopIntervalSync(id);
    try {
      logger.debug(`worker.beforeExit for ${id}`);
      await worker.beforeExit();
      logger.debug(`Thread.terminate for ${id}`);
      await Thread.terminate(worker);
      // await delay(100);
    } catch (error) {
      logger.error(`Wiki-worker have error ${(error as Error).message} when try to stop`, { function: 'stopWiki' });
      // await worker.terminate();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.wikiWorkers[id] as any) = undefined;
    logger.info(`Wiki-worker for ${id} stopped`, { function: 'stopWiki' });
  }

  /**
   * Stop all worker_thread, use and await this before app.quit()
   */
  public async stopAllWiki(): Promise<void> {
    logger.debug('stopAllWiki()', { function: 'stopAllWiki' });
    const tasks = [];
    for (const id of Object.keys(this.wikiWorkers)) {
      tasks.push(this.stopWiki(id));
    }
    await Promise.all(tasks);
    logger.info('All wiki workers are stopped', { function: 'stopAllWiki' });
  }

  /**
   * Send message to UI via WikiChannel.createProgress
   * @param message will show in the UI
   */
  private readonly logProgress = (message: string): void => {
    logger.info(message, { handler: WikiChannel.createProgress });
  };

  private readonly folderToContainSymlinks = 'subwiki';
  /**
   * Link a sub wiki to a main wiki, this will create a shortcut folder from main wiki to sub wiki, so when saving files to that shortcut folder, you will actually save file to the sub wiki
   * We place symbol-link (short-cuts) in the tiddlers/subwiki/ folder, and ignore this folder in the .gitignore, so this symlink won't be commit to the git, as it contains computer specific path.
   * @param {string} mainWikiPath folderPath of a wiki as link's destination
   * @param {string} folderName sub-wiki's folder name
   * @param {string} newWikiPath sub-wiki's folder path
   */
  public async linkWiki(mainWikiPath: string, folderName: string, subWikiPath: string): Promise<void> {
    const mainWikiTiddlersFolderSubWikisPath = path.join(mainWikiPath, TIDDLERS_PATH, this.folderToContainSymlinks);
    const subwikiSymlinkPath = path.join(mainWikiTiddlersFolderSubWikisPath, folderName);
    try {
      try {
        await remove(subwikiSymlinkPath);
      } catch {}
      await mkdirp(mainWikiTiddlersFolderSubWikisPath);
      await createSymlink(subWikiPath, subwikiSymlinkPath, 'junction');
      this.logProgress(i18n.t('AddWorkspace.CreateLinkFromSubWikiToMainWikiSucceed'));
    } catch (error: unknown) {
      throw new Error(i18n.t('AddWorkspace.CreateLinkFromSubWikiToMainWikiFailed', { subWikiPath, mainWikiTiddlersFolderPath: subwikiSymlinkPath, error }));
    }
  }

  private async createWiki(newFolderPath: string, folderName: string): Promise<void> {
    this.logProgress(i18n.t('AddWorkspace.StartUsingTemplateToCreateWiki'));
    const newWikiPath = path.join(newFolderPath, folderName);
    if (!(await pathExists(newFolderPath))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { path: newFolderPath }));
    }
    if (!(await pathExists(TIDDLYWIKI_TEMPLATE_FOLDER_PATH))) {
      throw new Error(i18n.t('AddWorkspace.WikiTemplateMissing', { TIDDLYWIKI_TEMPLATE_FOLDER_PATH }));
    }
    if (await pathExists(newWikiPath)) {
      throw new Error(i18n.t('AddWorkspace.WikiExisted', { newWikiPath }));
    }
    try {
      await copy(TIDDLYWIKI_TEMPLATE_FOLDER_PATH, newWikiPath, {
        filter: (source: string, destination: string) => {
          // xxx/template/wiki/.gitignore
          // xxx/template/wiki/.github
          // xxx/template/wiki/.git
          // prevent copy git submodule's .git folder
          if (source.endsWith('.git')) {
            return false;
          }
          // it will be copied if return true
          return true;
        },
      });
    } catch {
      throw new Error(i18n.t('AddWorkspace.CantCreateFolderHere', { newWikiPath }));
    }
    this.logProgress(i18n.t('AddWorkspace.WikiTemplateCopyCompleted') + newWikiPath);
  }

  public async createSubWiki(parentFolderLocation: string, folderName: string, subWikiFolderName: string, mainWikiPath: string, tagName = '', onlyLink = false): Promise<void> {
    this.logProgress(i18n.t('AddWorkspace.StartCreatingSubWiki'));
    const newWikiPath = path.join(parentFolderLocation, folderName);
    if (!(await pathExists(parentFolderLocation))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { path: parentFolderLocation }));
    }
    if (!onlyLink) {
      if (await pathExists(newWikiPath)) {
        throw new Error(i18n.t('AddWorkspace.WikiExisted', { newWikiPath }));
      }
      try {
        await mkdirs(newWikiPath);
      } catch {
        throw new Error(i18n.t('AddWorkspace.CantCreateFolderHere', { newWikiPath }));
      }
    }
    this.logProgress(i18n.t('AddWorkspace.StartLinkingSubWikiToMainWiki'));
    await this.linkWiki(mainWikiPath, folderName, newWikiPath);
    if (typeof tagName === 'string' && tagName.length > 0) {
      this.logProgress(i18n.t('AddWorkspace.AddFileSystemPath'));
      updateSubWikiPluginContent(mainWikiPath, newWikiPath, { tagName, subWikiFolderName });
    }

    this.logProgress(i18n.t('AddWorkspace.SubWikiCreationCompleted'));
  }

  public async removeWiki(wikiPath: string, mainWikiToUnLink?: string, onlyRemoveLink = false): Promise<void> {
    if (mainWikiToUnLink !== undefined) {
      const subWikiName = path.basename(wikiPath);
      await shell.trashItem(path.join(mainWikiToUnLink, TIDDLERS_PATH, this.folderToContainSymlinks, subWikiName));
    }
    if (!onlyRemoveLink) {
      await shell.trashItem(wikiPath);
    }
  }

  public async ensureWikiExist(wikiPath: string, shouldBeMainWiki: boolean): Promise<void> {
    if (!(await pathExists(wikiPath))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { path: wikiPath }));
    }
    const wikiInfoPath = path.resolve(wikiPath, 'tiddlywiki.info');
    if (shouldBeMainWiki && !(await pathExists(wikiInfoPath))) {
      throw new Error(i18n.t('AddWorkspace.ThisPathIsNotAWikiFolder', { wikiPath, wikiInfoPath }));
    }
    if (shouldBeMainWiki && !(await pathExists(path.join(wikiPath, TIDDLERS_PATH)))) {
      throw new Error(i18n.t('AddWorkspace.ThisPathIsNotAWikiFolder', { wikiPath }));
    }
  }

  public async checkWikiExist(workspace: IWorkspace, options: { shouldBeMainWiki?: boolean; showDialog?: boolean } = {}): Promise<string | true> {
    const { wikiFolderLocation, id: workspaceID } = workspace;
    const { shouldBeMainWiki, showDialog } = options;
    try {
      if (typeof wikiFolderLocation !== 'string' || wikiFolderLocation.length === 0 || !path.isAbsolute(wikiFolderLocation)) {
        const errorMessage = i18n.t('Dialog.NeedCorrectTiddlywikiFolderPath') + wikiFolderLocation;
        logger.error(errorMessage);
        const mainWindow = this.windowService.get(WindowNames.main);
        if (mainWindow !== undefined && showDialog === true) {
          await dialog.showMessageBox(mainWindow, {
            title: i18n.t('Dialog.PathPassInCantUse'),
            message: errorMessage,
            buttons: ['OK'],
            cancelId: 0,
            defaultId: 0,
          });
        }
        return errorMessage;
      }
      await this.ensureWikiExist(wikiFolderLocation, shouldBeMainWiki ?? false);
      return true;
    } catch (error) {
      const checkResult = (error as Error).message;

      const errorMessage = `${i18n.t('Dialog.CantFindWorkspaceFolderRemoveWorkspace')} ${wikiFolderLocation} ${checkResult}`;
      logger.error(errorMessage);
      const mainWindow = this.windowService.get(WindowNames.main);
      if (mainWindow !== undefined && showDialog === true) {
        const { response } = await dialog.showMessageBox(mainWindow, {
          title: i18n.t('Dialog.WorkspaceFolderRemoved'),
          message: errorMessage,
          buttons: [i18n.t('Dialog.RemoveWorkspace'), i18n.t('Dialog.DoNotCare')],
          cancelId: 1,
          defaultId: 0,
        });
        if (response === 0) {
          await this.workspaceViewService.removeWorkspaceView(workspaceID);
        }
      }
      return errorMessage;
    }
  }

  public async cloneWiki(parentFolderLocation: string, wikiFolderName: string, gitRepoUrl: string, gitUserInfo: IGitUserInfos): Promise<void> {
    this.logProgress(i18n.t('AddWorkspace.StartCloningWiki'));
    const newWikiPath = path.join(parentFolderLocation, wikiFolderName);
    if (!(await pathExists(parentFolderLocation))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { path: parentFolderLocation }));
    }
    if (await pathExists(newWikiPath)) {
      throw new Error(i18n.t('AddWorkspace.WikiExisted', { newWikiPath }));
    }
    try {
      await mkdir(newWikiPath);
    } catch {
      throw new Error(i18n.t('AddWorkspace.CantCreateFolderHere', { newWikiPath }));
    }
    await this.gitService.clone(gitRepoUrl, path.join(parentFolderLocation, wikiFolderName), gitUserInfo);
  }

  public async cloneSubWiki(
    parentFolderLocation: string,
    wikiFolderName: string,
    mainWikiPath: string,
    gitRepoUrl: string,
    gitUserInfo: IGitUserInfos,
    tagName = '',
  ): Promise<void> {
    this.logProgress(i18n.t('AddWorkspace.StartCloningSubWiki'));
    const newWikiPath = path.join(parentFolderLocation, wikiFolderName);
    if (!(await pathExists(parentFolderLocation))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { path: parentFolderLocation }));
    }
    if (await pathExists(newWikiPath)) {
      throw new Error(i18n.t('AddWorkspace.WikiExisted', { newWikiPath }));
    }
    try {
      await mkdir(newWikiPath);
    } catch {
      throw new Error(i18n.t('AddWorkspace.CantCreateFolderHere', { newWikiPath }));
    }
    await this.gitService.clone(gitRepoUrl, path.join(parentFolderLocation, wikiFolderName), gitUserInfo);
    this.logProgress(i18n.t('AddWorkspace.StartLinkingSubWikiToMainWiki'));
    await this.linkWiki(mainWikiPath, wikiFolderName, path.join(parentFolderLocation, wikiFolderName));
    if (typeof tagName === 'string' && tagName.length > 0) {
      this.logProgress(i18n.t('AddWorkspace.AddFileSystemPath'));
      updateSubWikiPluginContent(mainWikiPath, newWikiPath, { tagName, subWikiFolderName: wikiFolderName });
    }
  }

  // wiki-startup.ts

  private justStartedWiki: Record<string, boolean> = {};
  public setWikiStartLockOn(id: string): void {
    this.justStartedWiki[id] = true;
  }

  public setAllWikiStartLockOff(): void {
    this.justStartedWiki = {};
  }

  public checkWikiStartLock(id: string): boolean {
    return this.justStartedWiki[id] ?? false;
  }

  public async wikiStartup(workspace: IWorkspace): Promise<void> {
    const { id, isSubWiki, name, mainWikiID } = workspace;

    const userName = await this.authService.getUserName(workspace);

    // if is main wiki
    if (isSubWiki) {
      // if is private repo wiki
      // if we are creating a sub-wiki just now, restart the main wiki to load content from private wiki
      if (typeof mainWikiID === 'string' && !this.checkWikiStartLock(mainWikiID)) {
        const mainWorkspace = await this.workspaceService.get(mainWikiID);
        if (mainWorkspace === undefined) {
          throw new SubWikiSMainWikiNotExistError(name ?? id, mainWikiID);
        }
        await this.restartWiki(mainWorkspace);
      }
    } else {
      try {
        logger.debug('startWiki() calling startWiki');
        await this.startWiki(id, userName);
        logger.debug('startWiki() done');
      } catch (error) {
        logger.warn(`Get startWiki() error: ${(error as Error)?.message}`);
        if (error instanceof WikiRuntimeError && error.retry) {
          logger.warn('Get startWiki() WikiRuntimeError, retrying...');
          // don't want it to throw here again, so no await here.
          // eslint-disable-next-line @typescript-eslint/return-await
          return this.workspaceViewService.restartWorkspaceViewService(id);
        } else if ((error as Error).message.includes('Did not receive an init message from worker after')) {
          // https://github.com/andywer/threads.js/issues/426
          // wait some time and restart the wiki will solve this
          logger.warn(`Get startWiki() handle "${(error as Error)?.message}", will try restart wiki.`);
          await this.restartWiki(workspace);
        } else {
          logger.warn('Get startWiki() unexpected error, throw it');
          throw error;
        }
      }
    }
    await this.syncService.startIntervalSyncIfNeeded(workspace);
  }

  public async restartWiki(workspace: IWorkspace): Promise<void> {
    const { id, isSubWiki } = workspace;
    // use workspace specific userName first, and fall back to preferences' userName, pass empty editor username if undefined
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    const userName = await this.authService.getUserName(workspace);

    this.syncService.stopIntervalSync(id);
    if (!isSubWiki) {
      await this.stopWiki(id);
      await this.startWiki(id, userName);
    }
    await this.syncService.startIntervalSyncIfNeeded(workspace);
  }

  public async updateSubWikiPluginContent(mainWikiPath: string, subWikiPath: string, newConfig?: IWorkspace, oldConfig?: IWorkspace): Promise<void> {
    updateSubWikiPluginContent(mainWikiPath, subWikiPath, newConfig, oldConfig);
  }

  public async wikiOperationInBrowser<OP extends keyof ISendWikiOperationsToBrowser>(
    operationType: OP,
    workspaceID: string,
    arguments_: Parameters<ISendWikiOperationsToBrowser[OP]>,
  ) {
    // At least wait for wiki started. Otherwise some services like theme may try to call this method even on app start.
    await this.getWorkerEnsure(workspaceID);
    await this.viewService.getLoadedViewEnsure(workspaceID, WindowNames.main);
    const sendWikiOperationsToBrowser = getSendWikiOperationsToBrowser(workspaceID);
    if (typeof sendWikiOperationsToBrowser[operationType] !== 'function') {
      throw new TypeError(`${operationType} gets no useful handler`);
    }
    if (!Array.isArray(arguments_)) {
      // TODO: better type handling here
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/restrict-template-expressions
      throw new TypeError(`${(arguments_ as any) ?? ''} (${typeof arguments_}) is not a good argument array for ${operationType}`);
    }
    // @ts-expect-error A spread argument must either have a tuple type or be passed to a rest parameter.ts(2556) this maybe a bug of ts... try remove this comment after upgrade ts. And the result become void is weird too.
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression
    return await (sendWikiOperationsToBrowser[operationType](...arguments_) as unknown as ReturnType<ISendWikiOperationsToBrowser[OP]>);
  }

  public async wikiOperationInServer<OP extends keyof IWorkerWikiOperations>(
    operationType: OP,
    workspaceID: string,
    arguments_: Parameters<IWorkerWikiOperations[OP]>,
  ) {
    const worker = await this.getWorkerEnsure(workspaceID);
    // @ts-expect-error A spread argument must either have a tuple type or be passed to a rest parameter.ts(2556)
    return await (worker.wikiOperation(operationType, ...arguments_) as unknown as ReturnType<IWorkerWikiOperations[OP]>);
  }

  public async setWikiLanguage(workspaceID: string, tiddlywikiLanguageName: string): Promise<void> {
    const twLanguageUpdateTimeout = 15_000;
    // no need to wait setting wiki language, this sometimes cause slow PC to fail on this step
    void backOff(async () => {
      await (this.wikiOperationInBrowser(
        WikiChannel.setTiddlerText,
        workspaceID,
        ['$:/language', tiddlywikiLanguageName, { timeout: twLanguageUpdateTimeout }],
      ));
    }, {
      startingDelay: 2000,
    });
  }

  public async getTiddlerFilePath(title: string, workspaceID?: string): Promise<string | undefined> {
    const wikiWorker = this.getWorker(workspaceID ?? (await this.workspaceService.getActiveWorkspace())?.id ?? '');
    if (wikiWorker !== undefined) {
      const tiddlerFileMetadata = await wikiWorker.getTiddlerFileMetadata(title);
      if (tiddlerFileMetadata?.filepath !== undefined) {
        return tiddlerFileMetadata.filepath;
      }
    }
  }

  public async getWikiErrorLogs(workspaceID: string, wikiName: string): Promise<{ content: string; filePath: string }> {
    const filePath = path.join(LOG_FOLDER, getWikiErrorLogFileName(workspaceID, wikiName));
    const content = await readFile(filePath, 'utf8');
    return {
      content,
      filePath,
    };
  }
}
