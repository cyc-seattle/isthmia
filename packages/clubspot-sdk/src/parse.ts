/**
 * Typescript Wrappers around the Parse Javascript SDK.
 * @see https://parseplatform.org/Parse-SDK-JS/api/5.3.0/
 */
import Parse from "parse/node.js";
import winston from "winston";
export { Parse };

export type ObjectConstructor<T> = { new (options?: any): T };

interface Schema<T> {
  objectClass: string;
  className: string;
  clazz: ObjectConstructor<T>;
}

/**
 * A list of all Parse classes that have been registered.
 */
export const schemas: Schema<any>[] = [];

/**
 * Registers a subclass of Parse.Object with Parse. Requires that objectClass be a static property of the class.
 */
export function register<T extends Parse.Object>(
  clazz: ObjectConstructor<T>,
  context: ClassDecoratorContext,
): void {
  context.addInitializer(() => {
    const objectClass = (clazz as any)["objectClass"] as string;
    if (objectClass === undefined) {
      throw TypeError("objectClass must be defined on Parse.Objects");
    }

    const className = context.name!;

    schemas.push({ objectClass, className, clazz });
    Parse.Object.registerSubclass(objectClass, clazz);
  });
}

/**
 * A simple wrapper around query that logs to winston before any finalizer method is called.
 */
export class LoggedQuery<T extends Parse.Object> extends Parse.Query<T> {
  override find(options?: Parse.Query.FindOptions): Promise<T[]> {
    winston.debug("Executing Query:find", {
      objectClass: this.objectClass,
      query: this.toJSON(),
      options,
    });
    return super.find(options);
  }

  override get(objectId: string, options?: Parse.Query.GetOptions): Promise<T> {
    winston.debug("Executing Query:get", {
      objectClass: this.objectClass,
      objectId,
      options,
    });
    return super.get(objectId, options);
  }
}
