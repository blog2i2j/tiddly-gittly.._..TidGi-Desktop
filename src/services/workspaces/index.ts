/* eslint-disable @typescript-eslint/strict-boolean-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable unicorn/no-null */
import { app } from 'electron';
import fsExtra from 'fs-extra';
import { injectable } from 'inversify';
import { Jimp } from 'jimp';
import { mapValues, pickBy } from 'lodash';
import { nanoid } from 'nanoid';
import path from 'path';
import { BehaviorSubject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { WikiChannel } from '@/constants/channels';
import { DELAY_MENU_REGISTER } from '@/constants/parameters';
import { getDefaultTidGiUrl } from '@/constants/urls';
import { IAuthenticationService } from '@services/auth/interface';
import { lazyInject } from '@services/container';
import { IDatabaseService } from '@services/database/interface';
import { i18n } from '@services/libs/i18n';
import { logger } from '@services/libs/log';
import type { IMenuService } from '@services/menu/interface';
import { IPagesService, PageType } from '@services/pages/interface';
import serviceIdentifier from '@services/serviceIdentifier';
import { SupportedStorageServices } from '@services/types';
import type { IViewService } from '@services/view/interface';
import type { IWikiService } from '@services/wiki/interface';
import { WindowNames } from '@services/windows/WindowProperties';
import type { IWorkspaceViewService } from '@services/workspacesView/interface';
import type { INewWorkspaceConfig, IWorkspace, IWorkspaceMetaData, IWorkspaceService, IWorkspacesWithMetadata, IWorkspaceWithMetadata } from './interface';
import { registerMenu } from './registerMenu';
import { workspaceSorter } from './utils';

@injectable()
export class Workspace implements IWorkspaceService {
  /**
   * Record from workspace id to workspace settings
   */
  private workspaces: Record<string, IWorkspace> | undefined;
  public workspaces$ = new BehaviorSubject<IWorkspacesWithMetadata | undefined>(undefined);

  @lazyInject(serviceIdentifier.Wiki)
  private readonly wikiService!: IWikiService;

  @lazyInject(serviceIdentifier.Database)
  private readonly databaseService!: IDatabaseService;

  @lazyInject(serviceIdentifier.View)
  private readonly viewService!: IViewService;

  @lazyInject(serviceIdentifier.WorkspaceView)
  private readonly workspaceViewService!: IWorkspaceViewService;

  @lazyInject(serviceIdentifier.MenuService)
  private readonly menuService!: IMenuService;

  @lazyInject(serviceIdentifier.Authentication)
  private readonly authService!: IAuthenticationService;

  @lazyInject(serviceIdentifier.Pages)
  private readonly pagesService!: IPagesService;

  constructor() {
    setTimeout(() => {
      void registerMenu();
    }, DELAY_MENU_REGISTER);
  }

  public getWorkspacesWithMetadata(): IWorkspacesWithMetadata {
    return mapValues(this.getWorkspacesSync(), (workspace: IWorkspace, id): IWorkspaceWithMetadata => ({ ...workspace, metadata: this.getMetaDataSync(id) }));
  }

  public updateWorkspaceSubject(): void {
    this.workspaces$.next(this.getWorkspacesWithMetadata());
  }

  /**
   * Update items like "activate workspace1" or "open devtool in workspace1" in the menu
   */
  private async updateWorkspaceMenuItems(): Promise<void> {
    const newMenuItems = (await this.getWorkspacesAsList()).flatMap((workspace, index) => [
      {
        label: (): string => workspace.name || `Workspace ${index + 1}`,
        id: workspace.id,
        type: 'checkbox' as const,
        checked: () => workspace.active,
        click: async (): Promise<void> => {
          await this.workspaceViewService.setActiveWorkspaceView(workspace.id);
          // manually update menu since we have alter the active workspace
          await this.menuService.buildMenu();
        },
        accelerator: `CmdOrCtrl+${index + 1}`,
      },
      {
        label: () => `${workspace.name || `Workspace ${index + 1}`} ${i18n.t('Menu.DeveloperToolsActiveWorkspace')}`,
        id: `${workspace.id}-devtool`,
        click: async () => {
          const view = this.viewService.getView(workspace.id, WindowNames.main);
          if (view !== undefined) {
            view.webContents.toggleDevTools();
          }
        },
      },
    ]);
    /* eslint-enable @typescript-eslint/no-misused-promises */
    await this.menuService.insertMenu('Workspaces', newMenuItems, undefined, undefined, 'updateWorkspaceMenuItems');
  }

  /**
   * load workspaces in sync, and ensure it is an Object
   */
  private getInitWorkspacesForCache(): Record<string, IWorkspace> {
    const workspacesFromDisk = this.databaseService.getSetting(`workspaces`) ?? {};
    return typeof workspacesFromDisk === 'object' && !Array.isArray(workspacesFromDisk)
      ? mapValues(pickBy(workspacesFromDisk, (value) => value !== null) as unknown as Record<string, IWorkspace>, (workspace) => this.sanitizeWorkspace(workspace))
      : {};
  }

  public async getWorkspaces(): Promise<Record<string, IWorkspace>> {
    return this.getWorkspacesSync();
  }

  private getWorkspacesSync(): Record<string, IWorkspace> {
    // store in memory to boost performance
    if (this.workspaces === undefined) {
      this.workspaces = this.getInitWorkspacesForCache();
    }
    return this.workspaces;
  }

  public async countWorkspaces(): Promise<number> {
    return Object.keys(this.getWorkspacesSync()).length;
  }

  /**
   * Get sorted workspace list
   * Async so proxy type is async
   */
  public async getWorkspacesAsList(): Promise<IWorkspace[]> {
    return Object.values(this.getWorkspacesSync()).sort(workspaceSorter);
  }

  /**
   * Get sorted workspace list
   * Sync for internal use
   */
  private getWorkspacesAsListSync(): IWorkspace[] {
    return Object.values(this.getWorkspacesSync()).sort(workspaceSorter);
  }

  public async getSubWorkspacesAsList(workspaceID: string): Promise<IWorkspace[]> {
    const workspace = this.getSync(workspaceID);
    if (workspace === undefined) return [];
    if (workspace.isSubWiki) return [];
    return this.getWorkspacesAsListSync().filter((w) => w.mainWikiID === workspaceID).sort(workspaceSorter);
  }

  public getSubWorkspacesAsListSync(workspaceID: string): IWorkspace[] {
    const workspace = this.getSync(workspaceID);
    if (workspace === undefined) return [];
    if (workspace.isSubWiki) return [];
    return this.getWorkspacesAsListSync().filter((w) => w.mainWikiID === workspaceID).sort(workspaceSorter);
  }

  public async get(id: string): Promise<IWorkspace | undefined> {
    return this.getSync(id);
  }

  private getSync(id: string): IWorkspace | undefined {
    const workspaces = this.getWorkspacesSync();
    if (id in workspaces) {
      return workspaces[id];
    }
    // Try find with lowercased key. sometimes user will use id that is all lowercased. Because tidgi:// url is somehow lowercased.
    const foundKey = Object.keys(workspaces).find((key) => key.toLowerCase() === id.toLowerCase());
    return foundKey ? workspaces[foundKey] : undefined;
  }

  public get$(id: string): Observable<IWorkspace | undefined> {
    return this.workspaces$.pipe(map((workspaces) => workspaces?.[id]));
  }

  public async set(id: string, workspace: IWorkspace, immediate?: boolean): Promise<void> {
    const workspaces = this.getWorkspacesSync();
    const workspaceToSave = this.sanitizeWorkspace(workspace);
    await this.reactBeforeWorkspaceChanged(workspaceToSave);
    workspaces[id] = workspaceToSave;
    this.databaseService.setSetting('workspaces', workspaces);
    if (immediate === true) {
      await this.databaseService.immediatelyStoreSettingsToFile();
    }
    // update subject so ui can react to it
    this.updateWorkspaceSubject();
    // menu is mostly invisible, so we don't need to update it immediately
    void this.updateWorkspaceMenuItems();
  }

  public async update(id: string, workspaceSetting: Partial<IWorkspace>, immediate?: boolean): Promise<void> {
    const workspace = this.getSync(id);
    if (workspace === undefined) {
      logger.error(`Could not update workspace ${id} because it does not exist`);
      return;
    }
    await this.set(id, { ...workspace, ...workspaceSetting }, immediate);
  }

  public async setWorkspaces(newWorkspaces: Record<string, IWorkspace>): Promise<void> {
    for (const id in newWorkspaces) {
      await this.set(id, newWorkspaces[id]);
    }
  }

  public getMainWorkspace(subWorkspace: IWorkspace): IWorkspace | undefined {
    const { mainWikiID, isSubWiki, mainWikiToLink } = subWorkspace;
    if (!isSubWiki) return undefined;
    if (mainWikiID) return this.getSync(mainWikiID);
    const mainWorkspace = (this.getWorkspacesAsListSync() ?? []).find(
      (workspaceToSearch) => mainWikiToLink === workspaceToSearch.wikiFolderLocation,
    );
    return mainWorkspace;
  }

  /**
   * Pure function that make sure workspace setting is consistent, or doing migration across updates
   * @param workspaceToSanitize User input workspace or loaded workspace, that may contains bad values
   */
  private sanitizeWorkspace(workspaceToSanitize: IWorkspace): IWorkspace {
    const defaultValues: Partial<IWorkspace> = {
      storageService: SupportedStorageServices.github,
      backupOnInterval: true,
      excludedPlugins: [],
      enableHTTPAPI: false,
    };
    const fixingValues: Partial<IWorkspace> = {};
    // we add mainWikiID in creation, we fix this value for old existed workspaces
    if (workspaceToSanitize.isSubWiki && !workspaceToSanitize.mainWikiID) {
      const mainWorkspace = this.getMainWorkspace(workspaceToSanitize);
      if (mainWorkspace !== undefined) {
        fixingValues.mainWikiID = mainWorkspace.id;
      }
    }
    // fix WikiChannel.openTiddler in src/services/wiki/wikiOperations/executor/wikiOperationInBrowser.ts have \n on the end
    if (workspaceToSanitize.tagName?.endsWith('\n') === true) {
      fixingValues.tagName = workspaceToSanitize.tagName.replaceAll('\n', '');
    }
    // before 0.8.0, tidgi was loading http content, so lastUrl will be http protocol, but later we switch to tidgi:// protocol, so old value can't be used.
    if (!workspaceToSanitize.lastUrl?.startsWith('tidgi')) {
      fixingValues.lastUrl = null;
    }
    if (!workspaceToSanitize.homeUrl?.startsWith('tidgi')) {
      fixingValues.homeUrl = getDefaultTidGiUrl(workspaceToSanitize.id);
    }
    if (workspaceToSanitize.tokenAuth && !workspaceToSanitize.authToken) {
      fixingValues.authToken = this.authService.generateOneTimeAdminAuthTokenForWorkspaceSync(workspaceToSanitize.id);
    }
    return { ...defaultValues, ...workspaceToSanitize, ...fixingValues };
  }

  /**
   * Do some side effect before config change, update other services or filesystem, with new and old values
   * This happened after values sanitized
   * @param newWorkspaceConfig new workspace settings
   */
  private async reactBeforeWorkspaceChanged(newWorkspaceConfig: IWorkspace): Promise<void> {
    const existedWorkspace = this.getSync(newWorkspaceConfig.id);
    const { id, tagName } = newWorkspaceConfig;
    // when update tagName of subWiki
    if (existedWorkspace !== undefined && existedWorkspace.isSubWiki && typeof tagName === 'string' && tagName.length > 0 && existedWorkspace.tagName !== tagName) {
      const { mainWikiToLink, wikiFolderLocation } = existedWorkspace;
      if (typeof mainWikiToLink !== 'string') {
        throw new TypeError(
          `mainWikiToLink is null in reactBeforeWorkspaceChanged when try to updateSubWikiPluginContent, workspacesID: ${id}\n${
            JSON.stringify(
              this.workspaces,
            )
          }`,
        );
      }
      await this.wikiService.updateSubWikiPluginContent(mainWikiToLink, wikiFolderLocation, newWorkspaceConfig, {
        ...newWorkspaceConfig,
        tagName: existedWorkspace.tagName,
      });
      await this.wikiService.wikiStartup(newWorkspaceConfig);
    }
  }

  public async getByWikiFolderLocation(wikiFolderLocation: string): Promise<IWorkspace | undefined> {
    return (await this.getWorkspacesAsList()).find((workspace) => workspace.wikiFolderLocation === wikiFolderLocation);
  }

  public async getByWikiName(wikiName: string): Promise<IWorkspace | undefined> {
    return (await this.getWorkspacesAsList())
      .sort((a, b) => a.order - b.order)
      .find((workspace) => workspace.name === wikiName);
  }

  public getPreviousWorkspace = async (id: string): Promise<IWorkspace | undefined> => {
    const workspaceList = await this.getWorkspacesAsList();
    let currentWorkspaceIndex = 0;
    for (const [index, workspace] of workspaceList.entries()) {
      if (workspace.id === id) {
        currentWorkspaceIndex = index;
        break;
      }
    }
    if (currentWorkspaceIndex === 0) {
      return workspaceList.at(-1);
    }
    return workspaceList[currentWorkspaceIndex - 1];
  };

  public getNextWorkspace = async (id: string): Promise<IWorkspace | undefined> => {
    const workspaceList = await this.getWorkspacesAsList();
    let currentWorkspaceIndex = 0;
    for (const [index, workspace] of workspaceList.entries()) {
      if (workspace.id === id) {
        currentWorkspaceIndex = index;
        break;
      }
    }
    if (currentWorkspaceIndex === workspaceList.length - 1) {
      return workspaceList[0];
    }
    return workspaceList[currentWorkspaceIndex + 1];
  };

  public getActiveWorkspace = async (): Promise<IWorkspace | undefined> => {
    return this.getActiveWorkspaceSync();
  };

  public getActiveWorkspaceSync = (): IWorkspace | undefined => {
    return this.getWorkspacesAsListSync().find((workspace) => workspace.active);
  };

  public getFirstWorkspace = async (): Promise<IWorkspace | undefined> => {
    return this.getFirstWorkspaceSync();
  };

  public getFirstWorkspaceSync = (): IWorkspace | undefined => {
    return this.getWorkspacesAsListSync()[0];
  };

  public async setActiveWorkspace(id: string, oldActiveWorkspaceID: string | undefined): Promise<void> {
    // active new one
    await this.update(id, { active: true, hibernated: false });
    // de-active the other one
    if (oldActiveWorkspaceID !== id) {
      await this.clearActiveWorkspace(oldActiveWorkspaceID);
    }
    // switch from page to workspace, clear active page to switch to WikiBackground page
    const activePage = this.pagesService.getActivePageSync();
    // instead of switch to a wiki workspace, we simply clear active page, because wiki page logic is not implemented yet, we are still using workspace logic.
    await this.pagesService.clearActivePage(activePage?.id);
  }

  public async clearActiveWorkspace(oldActiveWorkspaceID: string | undefined): Promise<void> {
    // de-active the other one
    if (typeof oldActiveWorkspaceID === 'string') {
      await this.update(oldActiveWorkspaceID, { active: false });
    }
  }

  /**
   * @param id workspace id
   * @param sourcePicturePath image path, could be an image in app's resource folder or temp folder, we will copy it into app data folder
   */
  public async setWorkspacePicture(id: string, sourcePicturePath: string): Promise<void> {
    const workspace = this.getSync(id);
    if (workspace === undefined) {
      throw new Error(`Try to setWorkspacePicture() but this workspace is not existed ${id}`);
    }
    const pictureID = nanoid();

    if (workspace.picturePath === sourcePicturePath) {
      return;
    }

    const destinationPicturePath = path.join(app.getPath('userData'), 'pictures', `${pictureID}.png`) as `${string}.${string}`;

    const newImage = await Jimp.read(sourcePicturePath);
    await newImage.clone().resize({ w: 128, h: 128 }).write(destinationPicturePath);
    const currentPicturePath = this.getSync(id)?.picturePath;
    await this.update(id, {
      picturePath: destinationPicturePath,
    });
    if (currentPicturePath) {
      try {
        await fsExtra.remove(currentPicturePath);
      } catch (error) {
        console.error(error);
      }
    }
  }

  public async removeWorkspacePicture(id: string): Promise<void> {
    const workspace = this.getSync(id);
    if (workspace === undefined) {
      throw new Error(`Try to removeWorkspacePicture() but this workspace is not existed ${id}`);
    }
    if (workspace.picturePath) {
      await fsExtra.remove(workspace.picturePath);
      await this.set(id, {
        ...workspace,
        picturePath: null,
      });
    }
  }

  public async remove(id: string): Promise<void> {
    const workspaces = this.getWorkspacesSync();
    if (id in workspaces) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete workspaces[id];
      this.databaseService.setSetting('workspaces', workspaces);
    } else {
      throw new Error(`Try to remote workspace, but id ${id} is not existed`);
    }
    this.updateWorkspaceSubject();
    void this.updateWorkspaceMenuItems();
  }

  public async create(newWorkspaceConfig: INewWorkspaceConfig): Promise<IWorkspace> {
    const newID = nanoid();

    // find largest order
    const workspaceLst = await this.getWorkspacesAsList();
    let max = 0;
    for (const element of workspaceLst) {
      if (element.order > max) {
        max = element.order;
      }
    }

    const newWorkspace: IWorkspace = {
      userName: '',
      ...newWorkspaceConfig,
      active: false,
      disableAudio: false,
      disableNotifications: false,
      hibernated: false,
      hibernateWhenUnused: false,
      homeUrl: getDefaultTidGiUrl(newID),
      id: newID,
      lastUrl: null,
      lastNodeJSArgv: [],
      order: max + 1,
      picturePath: null,
      subWikiFolderName: 'subwiki',
      syncOnInterval: false,
      syncOnStartup: true,
      transparentBackground: false,
      enableHTTPAPI: false,
      excludedPlugins: [],
    };

    await this.set(newID, newWorkspace);

    return newWorkspace;
  }

  /** to keep workspace variables (meta) that
   * are not saved to disk
   * badge count, error, etc
   */
  private metaData: Record<string, Partial<IWorkspaceMetaData>> = {};

  public getMetaData = async (id: string): Promise<Partial<IWorkspaceMetaData>> => this.getMetaDataSync(id);
  private readonly getMetaDataSync = (id: string): Partial<IWorkspaceMetaData> => this.metaData[id] ?? {};

  public getAllMetaData = async (): Promise<Record<string, Partial<IWorkspaceMetaData>>> => this.metaData;

  public updateMetaData = async (id: string, options: Partial<IWorkspaceMetaData>): Promise<void> => {
    logger.debug(`updateMetaData(${id})`, options);
    this.metaData[id] = {
      ...this.metaData[id],
      ...options,
    };
    this.updateWorkspaceSubject();
  };

  public async workspaceDidFailLoad(id: string): Promise<boolean> {
    const workspaceMetaData = this.getMetaDataSync(id);
    return typeof workspaceMetaData?.didFailLoadErrorMessage === 'string' && workspaceMetaData.didFailLoadErrorMessage.length > 0;
  }

  public async openWorkspaceTiddler(workspace: IWorkspace, title?: string): Promise<void> {
    const { id: idToActive, isSubWiki, mainWikiID } = workspace;
    const oldActiveWorkspace = await this.getActiveWorkspace();
    await this.pagesService.setActivePage(PageType.wiki);
    logger.log('debug', 'openWorkspaceTiddler', { workspace });
    // If is main wiki, open the wiki, and open provided title, or simply switch to it if no title provided
    if (!isSubWiki && idToActive) {
      if (oldActiveWorkspace?.id !== idToActive) {
        await this.workspaceViewService.setActiveWorkspaceView(idToActive);
      }
      if (title) {
        await this.wikiService.wikiOperationInBrowser(WikiChannel.openTiddler, idToActive, [title]);
      }
      return;
    }
    // If is sub wiki, open the main wiki first and open the tag or provided title
    if (isSubWiki && mainWikiID) {
      if (oldActiveWorkspace?.id !== mainWikiID) {
        await this.workspaceViewService.setActiveWorkspaceView(mainWikiID);
      }
      const subWikiTag = title ?? workspace.tagName;
      if (subWikiTag) {
        await this.wikiService.wikiOperationInBrowser(WikiChannel.openTiddler, mainWikiID, [subWikiTag]);
      }
    }
  }
}
