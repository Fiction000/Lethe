import combineReducers from '../labs/combineReducers';
import createStore from '../labs/createStore';
import * as globalStore from './globalStateStore';
import * as locationStore from './locationStore';
import * as memoStore from './memoStore';
import * as dailyNotesStore from './dailyNotesStore';

interface AppState {
  globalState: globalStore.State;
  locationState: locationStore.State;
  memoState: memoStore.State;
  dailyNotesState: dailyNotesStore.State;
}

type AppStateActions =
  | globalStore.Actions
  | locationStore.Actions
  | memoStore.Actions
  | dailyNotesStore.Actions;

const appStore = createStore<AppState, AppStateActions>(
  {
    globalState: globalStore.defaultState,
    locationState: locationStore.defaultState,
    memoState: memoStore.defaultState,
    dailyNotesState: dailyNotesStore.defaultState,
  },
  combineReducers<AppState, AppStateActions>({
    globalState: globalStore.reducer,
    locationState: locationStore.reducer,
    memoState: memoStore.reducer,
    dailyNotesState: dailyNotesStore.reducer,  // Fixed: was dailyNotesStore
  }),
);

export default appStore;
