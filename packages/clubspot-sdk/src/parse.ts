/**
 * Typescript Wrappers around the Parse Javascript SDK.
 * @see https://parseplatform.org/Parse-SDK-JS/api/5.3.0/
 */
import Parse from 'parse/node.js';
export { Parse };

/* eslint-disable  @typescript-eslint/no-explicit-any */
export type ObjectConstructor<T> = { new (options?: any): T };

interface Schema<T> {
  objectClass: string;
  className: string;
  clazz: ObjectConstructor<T>;
}

/**
 * A list of all Parse classes that have been registered.
 */
/* eslint-disable  @typescript-eslint/no-explicit-any */
export const schemas: Schema<any>[] = [];

/**
 * Registers a subclass of Parse.Object with Parse. Requires that objectClass be a static property of the class.
 */
export function register<T extends Parse.Object>(
  clazz: ObjectConstructor<T>,
  context: ClassDecoratorContext,
): void {
  context.addInitializer(() => {
    /* eslint-disable  @typescript-eslint/no-explicit-any */
    const objectClass = (clazz as any)['objectClass'] as string;
    if (objectClass === undefined) {
      throw TypeError('objectClass must be defined on Parse.Objects');
    }

    const className = context.name!;

    schemas.push({ objectClass, className, clazz });
    Parse.Object.registerSubclass(objectClass, clazz);
  });
}
