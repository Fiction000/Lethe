import { moment } from 'obsidian';
import { getAllDailyNotes, getDailyNote } from 'obsidian-daily-notes-interface';
import utils from '../helpers/utils';
import { dailyNotesService } from '../services';
import type MemosPlugin from '../index';

class DailyNotePreCreationService {
  private initialized = false;
  private lastCheckDate: string | null = null;
  private plugin: MemosPlugin | null = null;

  /**
   * Set the plugin instance so we can access settings
   */
  public setPlugin(plugin: MemosPlugin): void {
    this.plugin = plugin;
  }

  /**
   * Initialize and pre-create today's and tomorrow's daily notes
   */
  public async initialize(): Promise<void> {
    try {
      // Check if feature is enabled
      if (!this.plugin?.settings.PreCreateDailyNotes) {
        console.log('[Lethe] Daily note pre-creation is disabled in settings');
        return;
      }

      console.log('[Lethe] Initializing daily note pre-creation...');

      // Pre-create today's note
      const today = moment();
      await this.ensureDailyNoteExists(today, 'today');

      // Pre-create tomorrow's note
      const tomorrow = moment().add(1, 'day');
      await this.ensureDailyNoteExists(tomorrow, 'tomorrow');

      // Store current date for rollover detection
      this.lastCheckDate = moment().format('YYYY-MM-DD');
      this.initialized = true;

      console.log('[Lethe] Daily note pre-creation initialized successfully');
    } catch (error) {
      console.error('[Lethe] Failed to initialize daily note pre-creation:', error);
      // Don't throw - we don't want to break plugin startup
    }
  }

  /**
   * Create note for specific date if it doesn't exist
   */
  private async ensureDailyNoteExists(date: moment.Moment, label: string): Promise<void> {
    try {
      console.log(`[Lethe] Pre-creating daily note for ${label}...`);

      // Check if daily notes plugin is available
      if (!this.isDailyNotesAvailable()) {
        console.log('[Lethe] Daily Notes or Periodic Notes plugin not available');
        return;
      }

      // Get all daily notes
      const dailyNotes = getAllDailyNotes();
      const existingFile = getDailyNote(date, dailyNotes);

      if (existingFile) {
        console.log(`[Lethe] Daily note for ${label} already exists: ${existingFile.path}`);
        return;
      }

      // Create the daily note
      const file = await utils.createDailyNoteCheck(date);
      console.log(`[Lethe] Successfully pre-created: ${file.path}`);

      // Update the daily notes cache
      await dailyNotesService.getMyAllDailyNotes();
    } catch (error) {
      console.error(`[Lethe] Failed to pre-create daily note for ${label}:`, error);
      // Don't throw - we want to continue with other dates
    }
  }

  /**
   * Check for midnight rollover and pre-create new tomorrow if needed
   */
  public async checkAndRollover(): Promise<void> {
    try {
      // Don't run if not initialized or feature is disabled
      if (!this.initialized || !this.plugin?.settings.PreCreateDailyNotes) {
        return;
      }

      const currentDate = moment().format('YYYY-MM-DD');

      // Check if date has changed (midnight rollover)
      if (this.lastCheckDate !== currentDate) {
        console.log('[Lethe] Midnight rollover detected');
        this.lastCheckDate = currentDate;

        // Pre-create new tomorrow
        const tomorrow = moment().add(1, 'day');
        await this.ensureDailyNoteExists(tomorrow, 'tomorrow (rollover)');
      }
    } catch (error) {
      console.error('[Lethe] Failed during rollover check:', error);
      // Don't throw - we don't want to break the interval
    }
  }

  /**
   * Manual refresh - useful for testing or if user wants to trigger pre-creation manually
   */
  public async refresh(): Promise<void> {
    this.initialized = false;
    this.lastCheckDate = null;
    await this.initialize();
  }

  /**
   * Check if Daily Notes or Periodic Notes plugin is available
   */
  private isDailyNotesAvailable(): boolean {
    // Check for Periodic Notes plugin
    const periodicNotes = (window as any).app.plugins?.getPlugin?.('periodic-notes');
    if (periodicNotes?.calendarSetManager?.getActiveConfig?.('day')?.enabled) {
      return true;
    }

    // Check for Daily Notes plugin (core plugin)
    // The daily notes interface will handle this
    try {
      getAllDailyNotes();
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Export singleton instance
export const dailyNotePreCreationService = new DailyNotePreCreationService();
export default dailyNotePreCreationService;
